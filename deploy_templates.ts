import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';

console.log('🚀 Starting template deployment process...');

const isWindows = process.platform === 'win32';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

const hasPython = (() => {
	try {
		execSync(isWindows ? 'python --version' : 'python3 --version', { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

if (hasPython) {
	const pythonCmd = isWindows ? 'python' : 'python3';
	// 1) Generate templates into build/
	console.log('🧱 Generating templates into build/ (Python found)...');
	try {
		execSync(`${pythonCmd} tools/generate_templates.py --clean --sync-lockfiles`, { stdio: 'inherit' });
		console.log('✅ Templates generated');
	} catch (error) {
		console.warn('⚠️  Failed to generate templates via Python. Continuing with existing build/ directory if any.');
	}

	// 2) Generate template catalog
	console.log('📋 Generating template catalog...');
	try {
		execSync(`${pythonCmd} generate_template_catalog.py --output template_catalog.json --pretty`, { stdio: 'inherit' });
		console.log('✅ Generated template catalog');
	} catch (error) {
		console.warn('⚠️  Failed to generate template catalog. Will use existing if present.');
	}
} else {
	console.log('⚠️  Python not found on this system. Skipping template generation and using pre-existing build/ and template_catalog.json.');
}

// Create optimized zip files for templates
console.log('📦 Creating optimized zip files for templates...');
const zipsDir = 'zips';
if (!existsSync(zipsDir)) {
	mkdirSync(zipsDir);
}

const buildDir = 'build';
if (!existsSync(buildDir)) {
	console.error(`❌ Build directory ${buildDir} not found.`);
	process.exit(1);
}

const dirs = readdirSync(buildDir);

for (const dirName of dirs) {
	const dirPath = join(buildDir, dirName);
	if (!statSync(dirPath).isDirectory() || dirName.startsWith('.')) {
		continue;
	}

	if (dirName === '.git' || dirName === 'node_modules' || dirName === '.github') {
		continue;
	}

	const hasPackageJson = existsSync(join(dirPath, 'package.json'));
	const hasWrangler = existsSync(join(dirPath, 'wrangler.jsonc')) || existsSync(join(dirPath, 'wrangler.toml'));
	const hasPrompts = existsSync(join(dirPath, 'prompts')) && statSync(join(dirPath, 'prompts')).isDirectory();

	if (hasPackageJson && hasWrangler && hasPrompts) {
		const zipFile = join('..', '..', zipsDir, `${dirName}.zip`);
		console.log(`Creating zip for: ${dirName}`);
		try {
			// Using OS-native zip methods:
			// Windows: tar.exe -a -c -f <zip_file> *
			// Unix: zip -r <zip_file> .
			const zipCommand = isWindows 
				? `tar.exe -a -c -f "${zipFile}" *` 
				: `zip -r "${zipFile}" .`;

			execSync(zipCommand, { stdio: 'ignore', cwd: dirPath });

			const finalZipPath = join(zipsDir, `${dirName}.zip`);
			if (existsSync(finalZipPath)) {
				const stats = statSync(finalZipPath);
				const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
				console.log(`✅ Created ${finalZipPath} (${sizeMB} MB)`);
			} else {
				console.error(`❌ Failed to create ${finalZipPath}`);
				process.exit(1);
			}
		} catch (error) {
			console.error(`❌ OS-level zipping failed for ${dirName}. Make sure tar/zip are available in your PATH.`);
			process.exit(1);
		}
	} else {
		console.log(`⏭️  Skipping ${dirName} (not a valid template)`);
	}
}

console.log('📦 All template zips created successfully');

// Verify Wrangler CLI is available
console.log('⚙️  Verifying Wrangler CLI...');
try {
	execSync(`${npxCmd} wrangler --version`, { stdio: 'ignore' });
	console.log('✅ Wrangler CLI ready');
} catch {
	console.error('❌ Wrangler CLI not found. Please run npm install.');
	process.exit(1);
}

const isLocalR2 = process.env.LOCAL_R2 === 'true';
const r2Flags = isLocalR2 ? '--local' : '--remote';
const r2Endpoint = isLocalR2 ? 'local R2' : 'Cloudflare R2';
const r2BucketName = process.env.R2_BUCKET_NAME || 'designai-templates';

console.log(`🚀 Uploading files to ${r2Endpoint}...`);

function uploadToR2(filePath: string, r2Key: string, description: string) {
	console.log(`Uploading: ${description}`);
	try {
		execSync(`${npxCmd} wrangler r2 object put "${r2BucketName}/${r2Key}" --file="${filePath}" ${r2Flags}`, { stdio: 'ignore' });
		console.log(`✅ Successfully uploaded ${description}`);
		return true;
	} catch (error) {
		console.error(`❌ Failed to upload ${description} to R2 (${error instanceof Error ? error.message : String(error)})`);
		return false;
	}
}

const failedUploads: string[] = [];

if (existsSync('template_catalog.json')) {
	if (!uploadToR2('template_catalog.json', 'template_catalog.json', 'template_catalog.json')) {
		failedUploads.push('template_catalog.json upload failed');
	}
} else {
	console.warn('⚠️  template_catalog.json not found, skipping upload');
}

const zipFiles = readdirSync(zipsDir).filter(f => f.endsWith('.zip'));
for (const zipFile of zipFiles) {
	const filePath = join(zipsDir, zipFile);
	if (!uploadToR2(filePath, zipFile, zipFile)) {
		failedUploads.push(`${zipFile} upload failed`);
	}
}

if (failedUploads.length > 0) {
	console.error('❌ Some uploads failed:');
	for (const failure of failedUploads) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log(`🎉 All files uploaded successfully to ${r2Endpoint} bucket: ${r2BucketName}`);
console.log('🎯 Template deployment completed successfully!');
