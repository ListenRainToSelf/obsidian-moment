import { Plugin, WorkspaceLeaf } from "obsidian";
import { MOMENT_VIEW_TYPE } from "./constants";
import MomentSettingTab, { MomentSettings, DEFAULT_SETTINGS } from "./settings";
import { MomentView } from "./view";
import { coverPath } from "./paths";

const HEARTBEAT_MS = 30_000;

export default class MomentPlugin extends Plugin {
	settings!: MomentSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new MomentSettingTab(this.app, this));

		// 注册视图
		this.registerView(
			MOMENT_VIEW_TYPE,
			(leaf) => new MomentView(leaf, this)
		);

		// 左侧栏图标
		this.addRibbonIcon("camera", "此刻 MOMENT", () => {
			this.activateView();
		});

		// 命令：打开朋友圈
		this.addCommand({
			id: "open-moment",
			name: "打开朋友圈视图",
			callback: () => this.activateView(),
		});

		// 命令：跳到今天 / 发布
		this.addCommand({
			id: "publish-moment",
			name: "发布一条此刻动态",
			callback: () => {
				const view = this.ensureView();
				if (view) view.openPublishForCommand();
			},
		});

		// vault 事件：即时刷新
		this.registerEvent(
			this.app.vault.on("create", () => this.scheduleRefresh())
		);
		this.registerEvent(
			this.app.vault.on("modify", () => this.scheduleRefresh())
		);
		this.registerEvent(
			this.app.vault.on("delete", () => this.scheduleRefresh())
		);

		// 轮询心跳兜底外部改动
		this.registerInterval(
			window.setInterval(() => this.heartbeat(), HEARTBEAT_MS)
		);

		// 启动时尝试打开一次（用户可从命令手动开）
		if (this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE).length) {
			this.refreshViews();
		}
	}

	onunload() {}

	/** 打开或聚焦视图（中间主区域标签页） */
	async activateView() {
		// 清理被放到了侧边栏/右侧栏的旧实例，避免复用它们
		this.app.workspace
			.getLeavesOfType(MOMENT_VIEW_TYPE)
			.forEach((l) => {
				if (this.isSidebarLeaf(l)) l.detach();
			});

		// 先让活动焦点落在主工作区，再在中间取一个标签页
		let mainLeaf: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((l) => {
			if (!mainLeaf && !this.isSidebarLeaf(l)) mainLeaf = l;
		});
		if (mainLeaf) this.app.workspace.setActiveLeaf(mainLeaf);

		const leaf = this.app.workspace.getLeaf(true) as WorkspaceLeaf;
		await leaf.setViewState({
			type: MOMENT_VIEW_TYPE,
			active: true,
		});
		await this.app.workspace.revealLeaf(leaf);
		this.refreshViews();
	}

	/** 判断叶子是否位于左右侧边栏（而非中间主区域） */
	private isSidebarLeaf(leaf: WorkspaceLeaf): boolean {
		const el = leaf.view.containerEl;
		return !!el && !!el.closest(".mod-left-split, .mod-right-split");
	}

	private ensureView(): MomentView | null {
		const leaves = this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE);
		for (const l of leaves) {
			if (l.view instanceof MomentView) return l.view;
		}
		return null;
	}

	refreshCover() {
		const v = this.ensureView();
		if (v) v.renderCoverPublic();
	}

	/** 背景文件名改动后：清空封面缓存并重绘 */
	reloadCover() {
		for (const l of this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE)) {
			if (l.view instanceof MomentView) l.view.reloadCoverPublic();
		}
	}

	/** 文字颜色等主题变量更新到所有打开的视图 */
	applyTheme() {
		for (const l of this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE)) {
			if (l.view instanceof MomentView) l.view.applyTheme();
		}
	}

	/** 将当前界面样式应用到所有已打开的视图 */
	applyStyle() {
		for (const l of this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE)) {
			if (l.view instanceof MomentView) {
				l.view.setStyleMode(this.settings.styleMode);
			}
		}
	}

	/** 图片排列模式切换：重绘信息流让新模式生效 */
	applyImageMode() {
		const v = this.ensureView();
		if (v) v.refreshPublic();
	}

	/** 汇聚的刷新调度（节流） */
	private _pending = false;
	private scheduleRefresh() {
		if (this._pending) return;
		this._pending = true;
		window.setTimeout(() => {
			this._pending = false;
			this.refreshViews();
		}, 150);
	}

	private heartbeat() {
		// 简单比对背景是否变化 + 刷新
		this.refreshViews();
	}

	private refreshViews() {
		const v = this.ensureView();
		if (v && document.visibilityState === "visible") {
			v.refreshPublic();
		}
	}

	private async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}