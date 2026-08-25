const { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } = require('fs');
const path = require('path');

function copyAssets(srcDir, destDir) {
	for (const entry of readdirSync(srcDir)) {
		const srcPath = path.join(srcDir, entry);
		const destPath = path.join(destDir, entry);
		if (statSync(srcPath).isDirectory()) {
			copyAssets(srcPath, destPath);
		} else if (/\.(svg|png)$/i.test(entry)) {
			mkdirSync(destDir, { recursive: true });
			copyFileSync(srcPath, destPath);
		}
	}
}

copyAssets(path.join(__dirname, '..', 'nodes'), path.join(__dirname, '..', 'dist', 'nodes'));

// tsc copies package.json into dist because it is listed in tsconfig "include"
// (needed there only for typed linting) — it does not belong in the build output
rmSync(path.join(__dirname, '..', 'dist', 'package.json'), { force: true });
console.log('Icons copied to dist/');
