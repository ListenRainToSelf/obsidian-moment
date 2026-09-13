#!/usr/bin/env node
/**
 * 把构建产物同步进 Obsidian 测试库，方便直接预览。
 *
 * - 只覆盖 main.js / manifest.json / styles.css
 * - 绝不触碰 data.json（那是你在设置界面调出来的配置）
 * - 目标目录可用环境变量 MOMENT_PLUGIN_DIR 覆盖
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 默认目标：Obsidian 测试库的插件目录 */
const DEFAULT_PLUGIN_DIR =
	"E:/Documents/obs测试/插件测试/.obsidian/plugins/MOMENT";

/** 需要同步的产物 */
const FILES = ["main.js", "manifest.json", "styles.css"];

export function copyPluginToVault({ quiet = false } = {}) {
	const destDir = process.env.MOMENT_PLUGIN_DIR || DEFAULT_PLUGIN_DIR;
	const pluginsDir = resolve(destDir, "..");
	if (!existsSync(pluginsDir)) {
		console.warn(`[deploy] 跳过：测试库插件目录不存在 → ${pluginsDir}`);
		return false;
	}
	for (const name of FILES) {
		if (!existsSync(join(ROOT, name))) {
			console.warn(`[deploy] 缺少构建产物 ${name}，请先执行 npm run build`);
			return false;
		}
	}
	mkdirSync(destDir, { recursive: true });
	for (const name of FILES) {
		copyFileSync(join(ROOT, name), join(destDir, name));
	}
	if (!quiet) {
		console.log(`[deploy] 已同步 ${FILES.join(", ")} → ${destDir}`);
	}
	return true;
}

// 直接以脚本方式执行时（node scripts/deploy.mjs）按结果给出退出码
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(copyPluginToVault() ? 0 : 1);
}
