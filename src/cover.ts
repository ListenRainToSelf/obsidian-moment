import { App, TFile, normalizePath } from "obsidian";
import type { MomentSettings } from "./settings";
import { coverPath, attachmentRoot } from "./paths";

/**
 * 背景自动加载：附件目录内的 img.jpg 即封面。
 * 提供监听方法，当该文件被修改 / 删除时给出最新引用。
 */
export class CoverLoader {
	private _ref?: string;

	constructor(private app: App, private settings: MomentSettings) {}

	/** 当前背景的相对路径（无则 undefined） */
	get ref(): string | undefined {
		if (!this._ref) {
			const img = this.app.vault.getAbstractFileByPath(
				coverPath(this.settings)
			);
			if (img instanceof TFile) this._ref = img.path;
		}
		return this._ref;
	}

	/** 附件目录内是否有 img.jpg */
	hasCover(): boolean {
		return !!this.ref;
	}

	/** 图片资源地址：优先 vault 资源，外部目录走 file:// */
	resolveUri(filePath: string): string {
		const name = normalizePath(filePath).split("/").pop() || filePath;
		// 若是附件目录内文件，用 vault 资源引用以获得缓存
		return this.app.vault.getResourcePath(
			this.app.vault.getAbstractFileByPath(filePath) as TFile
		) || name;
	}

	/** 背景清空（文件被删除时调用） */
	invalidate() {
		this._ref = undefined;
	}

	/** 附件目录路径（供外部位图拷贝用） */
	get root(): string {
		return attachmentRoot(this.settings);
	}
}