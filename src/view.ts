import {
	ItemView,
	WorkspaceLeaf,
	Notice,
	TFile,
	normalizePath,
	App,
	setIcon,
	Modal,
	ButtonComponent,
} from "obsidian";
import type MomentPlugin from "./main";
import type {
	MomentMessage,
	AggregationLevel,
	MomentDay,
} from "./types";
import { MOMENT_VIEW_TYPE, DEFAULT_MOODS } from "./constants";
import { DayFileStore } from "./dayFile";
import { CoverLoader } from "./cover";
import { ActivityGrid } from "./activityGrid";
import { OverviewBuilder, OverviewUnit } from "./overview";
import { attachmentPath, attachmentRoot } from "./paths";
import { dateParts } from "./settings";

const ACTIVITY_COLS = 7; // 7 列 = 一星期（周一~周日）
// 活跃度格点外观（用户调参值）
const CELL_H = 40;        // 格高 px
const CELL_GAP = 1;       // 间距 px
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
// 心情占比条的彩虹色谱：左端红 → 右端品红（不闭环，避免首尾撞色）
const MOOD_HUE_START = 0;
const MOOD_HUE_END = 300;

/**
 * 取下标对应的彩虹色：在色谱上等距取样，从左往右依次铺开。
 * 段数多于或少于 7 段时同样按比例取样（即取到色谱中的中间色）；
 * 只有一段时取色谱正中的颜色。
 */
function moodColor(index: number, total: number): string {
	const t = total <= 1 ? 0.5 : index / (total - 1);
	const hue = Math.round(MOOD_HUE_START + t * (MOOD_HUE_END - MOOD_HUE_START));
	return `hsl(${hue} 66% 56%)`;
}

// 心情下拉里“新建心情”哨兵值
const NEW_MOOD = "__new_mood__";

// 封面未指定颜色时的兜底：由主题色与底色混出一层柔和底色（设置留空 = 跟随主题色）
const COVER_TINT =
	"color-mix(in srgb, var(--moment-accent) 45%, var(--background-primary))";
const COVER_TINT_LIGHT =
	"color-mix(in srgb, var(--moment-accent) 60%, var(--background-primary))";
const COVER_TINT_DARK =
	"color-mix(in srgb, var(--moment-accent) 25%, var(--background-primary))";

/** 信息流单次加载 / 渲染的天数（按已有的日文件）；触底后再拉取下一批 */
const FEED_BATCH = 30;
/** 自动卸载保留窗口：视口上方 / 下方额外保留渲染的像素高度 */
const FEED_RETAIN_ABOVE = 1400;
const FEED_RETAIN_BELOW = 2000;

/** 信息流里的一个「天分组」（一天 = 一个窗口单元） */
interface FeedGroupEntry {
	date: Date;
	msgs: MomentMessage[];
	el: HTMLElement; // 分组容器（卸载后保留此节点做高度占位）
	height: number; // 最近一次渲染时测得的高度
	rendered: boolean; // 当前是否已挂载内容
	sig: string; // 内容签名，用于高度缓存命中判断
}

/** 内容签名：对条目的时间 / 心情 / 正文 / 图片做散列，任何改动都会变号，
 *  据此判断高度缓存与已渲染 DOM 是否仍然可用 */
function feedSig(msgs: MomentMessage[]): string {
	let h = 5381;
	for (const m of msgs) {
		const s = `${m.time}\u0001${m.mood || ""}\u0001${m.text}\u0001${m.images.join("\u0000")}\u0002`;
		for (let i = 0; i < s.length; i++) {
			h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
		}
	}
	return `${msgs.length}:${h.toString(36)}`;
}

/** 字符串 → 32 位散列（用于把「当天」稳定映射到名言池的一项） */
function hashStr(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
	}
	return h;
}

/** 高度缓存键：按年月日唯一标识一天 */
function feedKey(d: Date): string {
	const p = dateParts(d);
	return `${p.year}-${p.month}-${p.day}`;
}

/** 把占比气泡定位到某段的正上方（纯浮层，不参与布局，因此无需预留空间） */
function placePop(pop: HTMLElement, seg: HTMLElement, bar: HTMLElement) {
	const bw = bar.clientWidth || 100;
	const left0 = bar.offsetLeft || 0;
	const cx = left0 + seg.offsetLeft + seg.clientWidth / 2;
	pop.style.left = `${Math.max(left0 + 8, Math.min(left0 + bw - 8, cx))}px`;
	// 竖向锚在心情条上沿：量出气泡自身高度后整体上移，悬浮在条子之上
	pop.style.top = `${bar.offsetTop - (pop.offsetHeight || 22) - 6}px`;
	pop.style.transform = "translateX(-50%)";
}

export class MomentView extends ItemView {
	private plugin: MomentPlugin;
	private store: DayFileStore;
	private cover: CoverLoader;
	private overview: OverviewBuilder;

	// DOM
	private coverEl!: HTMLElement;
	private coverImgEl!: HTMLImageElement;
	private sigEl!: HTMLElement;
	private coverSize: { w: number; h: number } | null = null;
	private statsEl!: HTMLElement;
	private gridEl!: HTMLElement;
	private gridHeadEl!: HTMLElement;
	private weekEl!: HTMLElement;
	private quoteEl!: HTMLElement;
	private feedHost!: HTMLElement;
	private feedHeadEl!: HTMLElement;
	private feedMoreEl!: HTMLElement;
	private toTopEl!: HTMLElement;
	private overviewEl!: HTMLElement;
	private closeOvEl!: HTMLElement;
	private ovScrollEl!: HTMLElement;
	private ovLabelEl!: HTMLElement;
	// 全览聚合档位
	private segEls: Map<string, HTMLElement> = new Map();
	private aggr: AggregationLevel = "day";
	/** 全览渲染代号：切换档位时自增，丢弃过期的异步结果 */
	private overviewGen = 0;

	// 下拉
	private pullStartY = 0;
	private pullStartOffset = 0;
	private pulling = false;
	private inOverview = false;

	// 撤回后暂存，用于「重新编辑」
	private retracted: { date: Date; msg: MomentMessage } | null = null;
	private undoEl: HTMLElement | null = null;
	/** 当前打开的图片灯箱（挂在 body 上，随视图关闭一并清理） */
	private lightboxEl: HTMLElement | null = null;
	private lightboxClose: (() => void) | null = null;

	/** 心情筛选：选中的心情集合；空集合 = 未筛选，信息流与统计条均为原始形态 */
	private moodFilter = new Set<string>();
	/** 统计层已渲染内容的签名，避免高频刷新时重建 DOM 打断点击 / 悬停 */
	private moodStatsSig = "";
	private moodStatsDataSig = "";
	private moodStatsFullSig(): string {
		return `${this.moodStatsDataSig}|${[...this.moodFilter].join(",")}`;
	}
	/** 信息流筛选提示条已渲染内容的签名 */
	private feedFilterSig = "";

	// 信息流懒加载
	private feedDates: Date[] = []; // 已存在「日文件」的日期队列（新 → 旧）
	private feedRendered = 0; // 队列中已消费到的位置（游标）
	private feedHasGroup = false; // 是否已渲染出至少一个分组
	private feedLoading = false; // 是否正在加载 / 重绘（占位，避免并发插入）
	private feedGen = 0; // 渲染代号：refresh 自增以中断过期的异步加载

	// 信息流自动卸载（窗口化）
	private feedGroups: FeedGroupEntry[] = []; // 已创建的分组（按日期倒序）
	private feedHeights = new Map<string, { sig: string; h: number }>(); // 高度缓存
	private feedWinRaf = 0; // 窗口计算的 rAF 句柄（节流）

	constructor(leaf: WorkspaceLeaf, plugin: MomentPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.store = new DayFileStore(plugin.app, plugin.settings);
		this.cover = new CoverLoader(plugin.app, plugin.settings);
		this.overview = new OverviewBuilder(this.store);
	}

	getViewType(): string {
		return MOMENT_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "此刻 MOMENT";
	}
	getIcon(): string {
		return "camera";
	}

	async onOpen() {
		this.buildDom();
		this.bindPull();
		this.applyTheme();
		window.addEventListener("resize", this.onWindowResize);
		await this.store.ensureRoot(); // 创建「此刻」根目录与附件目录
		await this.refresh();
	}

	async onClose(): Promise<void> {
		window.removeEventListener("resize", this.onWindowResize);
		if (this.feedWinRaf) window.cancelAnimationFrame(this.feedWinRaf);
		this.feedWinRaf = 0;
		this.toTopEl?.remove();
		this.undoEl?.remove();
		this.coverEl?.remove();
		// 灯箱挂在 body 上，视图关闭时需手动清理，否则会残留在整页之上
		this.lightboxClose?.();
		this.lightboxEl?.remove();
		this.lightboxEl = null;
		this.lightboxClose = null;
	}

	/* ---------- 布局 ---------- */
	private buildDom() {
		const root = this.contentEl;
		root.empty();
		root.addClass("moment-view");
		root.addClass("moment-style-" + (this.plugin.settings.styleMode || "card"));

		// 主列（封面 + 活跃度 + 分隔）
		const main = root.createDiv({ cls: "moment-main" });

		// 封面
		this.coverEl = main.createDiv({ cls: "moment-cover" });
		this.coverImgEl = this.coverEl.createEl("img", {
			cls: "moment-cover-img",
		});
		// 默认渐变兜底
		this.coverEl.createDiv({ cls: "moment-cover-fallback" });
		const plus = this.coverEl.createEl("button", { cls: "moment-plus" });
		plus.textContent = "＋";
		plus.addEventListener("click", () => this.openPublish());
		// 全览入口（左上角，保证总览可打开）
		const navBtn = this.coverEl.createEl("button", {
			cls: "moment-nav-btn",
			attr: { title: "活跃度 · 全览" },
		});
		navBtn.innerHTML = GRID_SVG;
		navBtn.addEventListener("click", () =>
			this.toggleOverview(!this.inOverview)
		);
		// 关闭全览（与打开按钮同在封面左上角，同坐标保证严格重叠）
		// 该按钮独立存在以便总览覆盖层可正常关闭，默认隐藏、全览时显示
		this.closeOvEl = this.coverEl.createEl("button", {
			cls: "moment-ov-close",
			attr: { title: "退出全览" },
		});
		this.closeOvEl.innerHTML = EXIT_SVG;
		this.closeOvEl.addEventListener("click", () => this.toggleOverview(false));
		this.sigEl = this.coverEl.createDiv({ cls: "moment-signature" });
		// 心情统计：仅鼠标悬停封面时，从底部渐变模糊层上滑显示
		this.statsEl = this.coverEl.createDiv({ cls: "moment-stats" });
		// 悬停封面：按图片实际比例撑满整图高度（完整显示）
		this.coverEl.addEventListener("mouseenter", this.expandCover);
		this.coverEl.addEventListener("mouseleave", this.shrinkCover);

		// 活跃度
		const act = main.createDiv({ cls: "moment-activity" });
		this.gridHeadEl = act.createDiv({ cls: "moment-activity-head" });
		const actBody = act.createDiv({ cls: "moment-activity-body" });
		this.gridEl = actBody.createDiv({ cls: "moment-activity-grid" });
		this.weekEl = actBody.createDiv({ cls: "moment-activity-week" }); // 星期栏在右侧

		// 灰分界线 + 名言
		const split = main.createDiv({ cls: "moment-split" });
		split.createDiv({ cls: "moment-split-line" });
		this.quoteEl = split.createDiv({ cls: "moment-quote" });
		split.createDiv({ cls: "moment-split-line" });

		// 信息流（整段自然往下排，交由页面整体滚动，无内层滚动条）
		const feedWrap = root.createDiv({ cls: "moment-feed-wrap" });
		this.feedHeadEl = feedWrap.createDiv({ cls: "moment-feed-head" });
		this.feedHost = feedWrap.createDiv({ cls: "moment-feed" });
		// 触底加载提示条（哨兵），滚到接近底部时拉取下一批
		this.feedMoreEl = feedWrap.createDiv({ cls: "moment-feed-more" });

		// 页面整体滚动监听，用于“回到顶部”按钮显隐
		root.addEventListener("scroll", this.onPageScroll);

		// 回到顶部按钮（固定于视口右下角）
		this.toTopEl = document.createElement("div");
		this.toTopEl.className = "moment-to-top";
		this.toTopEl.innerHTML = TOP_SVG;
		this.toTopEl.setAttribute("title", "回到顶部");
		this.toTopEl.addEventListener("click", () =>
			root.scrollTo({ top: 0, behavior: "smooth" })
		);
		document.body.appendChild(this.toTopEl);

		// 全览覆盖
		this.buildOverview(root);
	}

	private onPageScroll = () => {
		const show = !this.inOverview && this.contentEl.scrollTop > 160;
		this.toTopEl?.classList.toggle("show", show);
		if (this.inOverview) return;
		// 滚动接近底部时，拉取并渲染下一批动态
		this.maybeLoadMoreFeed();
		// 卸载移出可视窗口的分组，控制 DOM / 资源占用
		this.scheduleFeedWindow();
	};

	private onWindowResize = () => {
		this.scheduleFeedWindow();
	};

	/** 用 rAF 节流窗口计算，避免每个滚动事件都触发大量布局读取 */
	private scheduleFeedWindow() {
		if (this.feedWinRaf) return;
		this.feedWinRaf = window.requestAnimationFrame(() => {
			this.feedWinRaf = 0;
			this.applyFeedWindow();
		});
	}

	/**
	 * 自动卸载：只保留视口上下若干像素内的分组为「已渲染」，
	 * 其余分组清空内容并保留原高度占位（滚动位置不变）。
	 */
	private applyFeedWindow() {
		if (this.inOverview || !this.feedGroups.length) return;
		const host = this.contentEl.getBoundingClientRect();
		const topEdge = host.top - FEED_RETAIN_ABOVE;
		const botEdge = host.bottom + FEED_RETAIN_BELOW;
		// 第一遍只读：采集各分组当前位置，避免「读-写」交错触发反复回流。
		// 分组按日期倒序在文档中自上而下排列，位置单调：一旦某组顶边已落到
		// 保留区下方，其后所有分组都在下方，无需再逐个测量。
		const mounts: FeedGroupEntry[] = [];
		const unmounts: FeedGroupEntry[] = [];
		for (let i = 0; i < this.feedGroups.length; i++) {
			const g = this.feedGroups[i];
			const r = g.el.getBoundingClientRect();
			if (r.top >= botEdge) {
				for (let j = i; j < this.feedGroups.length; j++) {
					const rest = this.feedGroups[j];
					if (rest.rendered) unmounts.push(rest);
				}
				break;
			}
			const inWindow = r.bottom > topEdge;
			if (inWindow && !g.rendered) mounts.push(g);
			else if (!inWindow && g.rendered) unmounts.push(g);
		}
		// 第二遍只写：卸载保留高度、挂载沿用缓存高度，滚动不跳动
		for (const g of unmounts) this.unmountFeedGroup(g);
		for (const g of mounts) this.mountFeedGroup(g);
	}

	private buildOverview(root: HTMLElement) {
		this.overviewEl = root.createDiv({ cls: "moment-overview" });
		const seg = this.overviewEl.createDiv({ cls: "moment-ov-seg" });
		for (const lvl of ["day", "week", "month", "year"] as AggregationLevel[]) {
			const item = seg.createEl("button", {
				cls: "moment-ov-seg-item",
				text: { day: "天", week: "周", month: "月", year: "年" }[lvl],
			});
			this.segEls.set(lvl, item);
			item.addEventListener("click", () => {
				if (this.aggr !== lvl) {
					this.aggr = lvl;
					this.renderOverview();
				}
			});
		}
		// 退出全览按钮现已在封面内创建（closeOvEl），与打开按钮同坐标
		this.ovScrollEl = this.overviewEl.createDiv({ cls: "moment-ov-scroll" });
		this.ovLabelEl = this.overviewEl.createDiv({ cls: "moment-ov-label" });
		this.ovScrollEl.addEventListener("wheel", this.onWheel, { passive: false });
	}

	/** 滚轮接管：仅在「全览」内驱动其滚动；日常信息流交由页面整体滚动 */
	private onWheel = (e: WheelEvent) => {
		if (!this.inOverview) return;
		this.ovScrollEl.scrollTop += e.deltaY;
		e.preventDefault();
	};

	/* ---------- 下拉手势 ---------- */
	private bindPull() {
		const v = this.contentEl;
		v.addEventListener("pointerdown", (e) => {
			// 忽略按钮/链接/输入框等交互目标，保证它们的 click 正常触发
			const t = e.target as HTMLElement;
			if (t.closest("button, a, input, textarea")) return;
			this.pullStartY = e.clientY;
			this.pullStartOffset = 0;
			this.pulling = true;
		});
		v.addEventListener("pointermove", (e) => {
			if (!this.pulling) return;
			const scroller = this.inOverview ? this.ovScrollEl : this.contentEl;
			const atTop = scroller.scrollTop === 0;
			const dy = e.clientY - this.pullStartY;
			// 8px 死区避免与点击/悬停冲突
			if (atTop && dy > 8) {
				this.pullStartOffset = Math.min(dy * 0.45, 140);
				v.style.transform = `translateY(${this.pullStartOffset}px)`;
				e.preventDefault();
			}
		});
		const end = () => {
			if (!this.pulling) return;
			this.pulling = false;
			const over = this.pullStartOffset >= 70;
			v.style.transition = "transform .22s ease";
			v.style.transform = "";
			setTimeout(() => {
				v.style.transition = "";
			}, 240);
			// 视图顶下拉开 / 关全览
			if (over) this.toggleOverview(!this.inOverview);
		};
		v.addEventListener("pointerup", end);
		v.addEventListener("pointercancel", end);
		v.addEventListener("pointerleave", end);
	}

	/* ---------- 供插件入口调用 ---------- */
	async refreshPublic(fresh = false) {
		return this.refresh(fresh);
	}
	renderCoverPublic() {
		this.renderCover();
	}
	/** 背景文件名改动：清空缓存并重绘封面 */
	reloadCoverPublic() {
		this.cover.invalidate();
		this.coverSizeSrc = ""; // 背景可能换了图，重新量一次比例
		this.renderCover();
	}
	/** 库内新增 / 删除文件：让日文件列表缓存立即失效，新的一天当次刷新即可见 */
	invalidateDayList() {
		this.store.invalidateDayList();
	}
	openPublishForCommand() {
		this.openPublish();
	}
	/** 切换界面样式（卡片 / 平面）而不重渲染 */
	setStyleMode(mode: "card" | "flat") {
		this.contentEl.classList.remove("moment-style-card", "moment-style-flat");
		this.contentEl.classList.add("moment-style-" + (mode || "card"));
	}

	/* ---------- 刷新 ---------- */
	async refresh(fresh = false) {
		this.renderCover();
		await Promise.all([
			this.renderActivity(fresh),
			this.renderFeed(fresh),
			this.renderQuote(),
			this.renderMoodStats(fresh),
		]);
	}

	/** 封面悬停层：持续活跃 / 日常总数 / 今日日常 + 心情占比单长条 */
	private async renderMoodStats(fresh = false) {
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const todayKey = dateParts(today).dateKey;
		const range = 30;

		const moodCounts = new Map<string, number>();
		const dayCounts = new Map<string, number>(); // dateKey -> 条数
		let total = 0;
		// 并行取数：这 30 天与信息流 / 活跃度高度重叠，交给 store 去重后
		// 实际只读一轮，串行等待没有意义。
		const keys: string[] = [];
		const jobs: Promise<MomentDay | null>[] = [];
		for (let i = 0; i < range; i++) {
			const d = new Date(today);
			d.setDate(today.getDate() - i);
			keys.push(dateParts(d).dateKey);
			jobs.push(this.store.readDay(d, fresh));
		}
		const days = await Promise.all(jobs);
		for (let i = 0; i < days.length; i++) {
			const day = days[i];
			if (!day || !day.messages.length) continue;
			dayCounts.set(keys[i], day.messages.length);
			total += day.messages.length;
			for (const msg of day.messages) {
				if (msg.mood && msg.mood.trim()) {
					const m = msg.mood.trim();
					moodCounts.set(m, (moodCounts.get(m) || 0) + 1);
				}
			}
		}

		// 持续活跃天数：以今天为锚（今天无记录则从昨天向前连续数）
		let streak = 0;
		let cursor = new Date(today);
		if (!dayCounts.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
		while (dayCounts.has(dateParts(cursor).dateKey)) {
			streak++;
			cursor.setDate(cursor.getDate() - 1);
		}
		const todayCount = dayCounts.get(todayKey) || 0;

		// 心情占比（用带心情的动态做分母）
		const moodTotal = [...moodCounts.values()].reduce((a, b) => a + b, 0);
		const list = [...moodCounts.entries()].sort((a, b) => b[1] - a[1]);

		// 内容与筛选态都没变时跳过重建：刷新很频繁，重建会把鼠标正按着的
		// 色块换掉，导致点击 / 悬停丢失。
		this.moodStatsDataSig = `${streak}|${total}|${todayCount}|${list
			.map(([n, c]) => `${n}:${c}`)
			.join(",")}`;
		if (this.moodStatsFullSig() === this.moodStatsSig) return;
		this.moodStatsSig = this.moodStatsFullSig();

		this.statsEl.empty();
		this.statsEl.createDiv({ cls: "moment-stats-bg" }); // 首层：去边缘高斯模糊，内容叠于其上

		// 三组数字
		const top = this.statsEl.createDiv({ cls: "moment-stats-top" });
		this.statItem(top, "持续活跃", `${streak}天`);
		this.statItem(top, "日常总数", `${total}`);
		this.statItem(top, "今日日常", `${todayCount}`);

		// 心情占比标题
		this.statsEl.createDiv({ cls: "moment-stats-share", text: "心情占比" });

		if (moodTotal > 0 && list.length) {
			const filtering = this.moodFilter.size > 0;
			const bar = this.statsEl.createDiv({
				cls: "moment-stats-segbar" + (filtering ? " filtering" : ""),
			});
			const pop = this.statsEl.createDiv({ cls: "moment-stats-pop" });
			list.forEach(([name, n], idx) => {
				const pct = (n / moodTotal) * 100;
				const on = this.moodFilter.has(name);
				const seg = bar.createDiv({
					cls: "moment-stats-seg" + (on ? " on" : ""),
				});
				seg.dataset.mood = name;
				seg.style.width = `${pct}%`;
				seg.style.background = moodColor(idx, list.length);
				seg.title = `${name} / ${pct.toFixed(1)}% / ${n}次`;
				seg.addEventListener("mouseenter", () => {
					pop.textContent = `${name} · ${pct.toFixed(1)}% · ${n}次`;
					pop.classList.add("show");
					placePop(pop, seg, bar);
				});
				seg.addEventListener("mouseleave", () =>
					pop.classList.remove("show")
				);
				// 单击切换该心情的筛选；可多选，再次点击取消
				seg.addEventListener("click", (e) => {
					e.stopPropagation();
					this.toggleMoodFilter(name);
				});
			});
		} else {
			this.statsEl.createDiv({
				cls: "moment-stats-empty",
				text: "暂无带心情的动态",
			});
		}
		this.renderMoodFilterRow();
	}

	/** 统计条下方的筛选状态行（有筛选时才出现），提供一键清除 */
	private renderMoodFilterRow() {
		this.statsEl.querySelector(".moment-stats-filter")?.remove();
		if (!this.moodFilter.size) return;
		const row = this.statsEl.createDiv({ cls: "moment-stats-filter" });
		row.createSpan({
			cls: "txt",
			text: `筛选中：${[...this.moodFilter].join(" · ")}`,
		});
		const clear = row.createEl("button", {
			cls: "moment-stats-clear",
			text: "清除",
		});
		clear.addEventListener("click", (e) => {
			e.stopPropagation();
			this.clearMoodFilter();
		});
	}

	/** 只更新统计条的选中 / 变暗态，避免整块重建导致悬停丢失 */
	private syncMoodFilterUI() {
		const bar = this.statsEl.querySelector<HTMLElement>(
			".moment-stats-segbar"
		);
		bar?.classList.toggle("filtering", this.moodFilter.size > 0);
		this.statsEl
			.querySelectorAll<HTMLElement>(".moment-stats-seg")
			.forEach((seg) => {
				seg.classList.toggle(
					"on",
					this.moodFilter.has(seg.dataset.mood || "")
				);
			});
		this.renderMoodFilterRow();
		// DOM 已就地更新完毕，同步签名，使紧随其后的刷新不再整块重建
		this.moodStatsSig = this.moodStatsFullSig();
	}

	/** 切换某心情的筛选状态（多选）；集合清空后统计条与信息流恢复原样 */
	private toggleMoodFilter(mood: string) {
		if (this.moodFilter.has(mood)) this.moodFilter.delete(mood);
		else this.moodFilter.add(mood);
		this.syncMoodFilterUI();
		this.applyMoodFilterToFeed();
	}

	private clearMoodFilter() {
		if (!this.moodFilter.size) return;
		this.moodFilter.clear();
		this.syncMoodFilterUI();
		this.applyMoodFilterToFeed();
	}

	/** 按当前心情筛选过滤一天的动态；未开启筛选时原样返回 */
	private filterMsgs(msgs: MomentMessage[]): MomentMessage[] {
		if (!this.moodFilter.size) return msgs;
		return msgs.filter((m) => !!m.mood && this.moodFilter.has(m.mood));
	}

	/** 筛选变化后重建信息流：重置分页游标，从最新开始按天分组呈现 */
	private applyMoodFilterToFeed() {
		this.feedGen++; // 中断在途的旧批次
		this.feedRendered = 0;
		this.feedGroups = [];
		this.feedHasGroup = false;
		void this.renderFeed();
	}

	/** 单项数字统计 */
	private statItem(host: HTMLElement, label: string, value: string) {
		const item = host.createDiv({ cls: "moment-stat" });
		item.createSpan({ cls: "v", text: value });
		item.createSpan({ cls: "l", text: label });
	}

	/** 是否存在可完整展示的背景图片（本地文件 / 网络 URL） */
	private hasBackgroundImage(): boolean {
		const s = this.plugin.settings;
		return (s.coverMode || "file") === "file"
			? this.cover.hasCover()
			: s.coverMode === "url" && !!s.bgUrl;
	}
	/** 读取背景原图的自然尺寸，用于悬停时按比例撑满 */
	private coverSizeSrc = "";
	private loadCoverSize(): void {
		if (!this.hasBackgroundImage()) {
			this.coverSize = null;
			this.coverSizeSrc = "";
			return;
		}
		const s = this.plugin.settings;
		const src =
			(s.coverMode || "file") === "file"
				? this.app.vault.getResourcePath(
						this.app.vault.getAbstractFileByPath(
							this.cover.ref as string
						) as TFile
				  )
				: (s.bgUrl as string);
		if (!src) {
			this.coverSize = null;
			this.coverSizeSrc = "";
			return;
		}
		// 同一张图只解码一次：刷新非常频繁，重复 new Image 会反复解码整张大图
		if (src === this.coverSizeSrc) return;
		this.coverSizeSrc = src;
		this.coverSize = null;
		const img = new Image();
		img.onload = () => {
			if (img.naturalWidth && img.naturalHeight)
				this.coverSize = { w: img.naturalWidth, h: img.naturalHeight };
		};
		img.src = src;
	}
	/** 悬停：按图片实际比例撑满整图，完整显示 */
	private expandCover = () => {
		if (!this.hasBackgroundImage()) return;
		const w = this.coverEl.clientWidth || this.coverEl.offsetWidth || 800;
		if (this.coverSize && w > 0) {
			const target = (this.coverSize.h / this.coverSize.w) * w;
			const max = Math.min(window.innerHeight * 0.72, 620);
			this.coverEl.style.height = `${Math.min(target, max)}px`;
		} else {
			this.coverEl.style.height = ""; // 交回 CSS :hover 兜底
		}
	};
	private shrinkCover = () => {
		this.coverEl.style.height = "";
	};

	renderCover() {
		const s = this.plugin.settings;
		const mode = s.coverMode || "file";
		this.coverEl.style.background = "";
		this.coverEl.style.backgroundImage = "";
		this.coverEl.style.backgroundSize = "";
		this.coverEl.style.backgroundPosition = "";

		// 背景图片显示高度段（7 档：0=顶 … 6=底 → 0%~100%）
		const align = Math.min(6, Math.max(0, this.plugin.settings.coverAlign ?? 3));
		const posY = (align / 6) * 100;
		this.coverImgEl.style.objectPosition = `50% ${posY}%`;
		this.coverEl.style.backgroundPositionY = `${posY}%`;

		if (mode === "color") {
			this.coverImgEl.style.display = "none";
			this.coverEl.style.backgroundColor = s.bgColor || COVER_TINT;
		} else if (mode === "gradient") {
			this.coverImgEl.style.display = "none";
			this.coverEl.style.backgroundImage =
				`linear-gradient(120deg, ${s.gradientA || COVER_TINT_LIGHT}, ${s.gradientB || COVER_TINT_DARK})`;
		} else if (mode === "url") {
			this.coverImgEl.style.display = "none";
			if (s.bgUrl) {
				this.coverEl.style.backgroundImage = `url("${s.bgUrl}")`;
				this.coverEl.style.backgroundSize = "cover";
				this.coverEl.style.backgroundPosition = "center";
			}
		} else {
			// “本地图片”：优先附件内背景图，找不到则回落到 CSS 默认渐变
			const uri = this.cover.ref;
			if (uri && this.cover.hasCover()) {
				this.coverImgEl.src = this.app.vault.getResourcePath(
					this.app.vault.getAbstractFileByPath(uri) as TFile
				);
				this.coverImgEl.style.display = "";
			} else {
				this.coverImgEl.src = "";
				this.coverImgEl.style.display = "none";
			}
		}
		this.sigEl.textContent =
			this.plugin.settings.signature || DEFAULT_SIGN;
		this.loadCoverSize();
	}

	/** 套用文字颜色主题变量（空则跟随主题） */
	applyTheme() {
		const tc = (this.plugin.settings.textColor || "").trim();
		this.contentEl.style.setProperty(
			"--moment-fore",
			tc.length >= 3 && tc.startsWith("#") ? tc : ""
		);
	}

	private async renderActivity(fresh = false) {
		// 1) 准备星期栏（右侧，一~日共 7 行；行序被旋转，令“今日”恒在底部/右下格）
		const today = new Date();
		const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
		const todayKey =
			`${t0.getFullYear()}-${t0.getMonth() + 1}-${t0.getDate()}`;
		const wdMon0 = (d: Date) => (d.getDay() + 6) % 7; // 周一=0 … 周日=6
		const todayWd = wdMon0(t0);

		// 2) 用“可见内容区”宽度反推周数，确保所有列都放得下、今日始终可见、不溢出
		this.weekEl.empty();
		const body = this.gridEl.parentElement as HTMLElement;
		const bodyW = (body && body.clientWidth) || 400;
		// 先放一排占位测星期栏宽度
		for (let i = 0; i < ACTIVITY_COLS; i++) {
			this.weekEl.createDiv({ cls: "moment-activity-week-item", text: "一" });
		}
		const weekW = this.weekEl.clientWidth || 16;
		const avail = Math.max(160, bodyW - weekW - 12);
		const slot = CELL_H + CELL_GAP; // 一个格子的步进（含间距）
		const weeks = Math.max(1, Math.floor((avail + CELL_GAP) / slot));
		// 需显示的天数：完整周 × 7 + 本周已过的天（本周一 ← 今天）
		const spanDays = (weeks - 1) * ACTIVITY_COLS + todayWd + 1;

		const grid = new ActivityGrid(spanDays);
		const cells = await grid.compute(this.store, fresh);

		// 列数与逐日条数都没变时直接复用已渲染的格子。
		// 刷新多由库内其它文件改动触发，此时活跃度数据通常原封不动，
		// 重建上百个格子纯属抖动，这里提前返回。
		this.lastWeeks = weeks;
		const sig = `${weeks}|${cells
			.map((c) => `${c.date}:${c.count}`)
			.join(",")}`;
		if (sig === this.activitySig) {
			this.renderWeekColumn(); // 开头测宽时清空过星期栏，需补回
			this.refreshOnResize();
			return;
		}
		this.activitySig = sig;

		const total = cells.reduce((n, c) => n + c.count, 0);
		this.gridHeadEl.innerHTML =
			`<span>活跃度</span><b>近${spanDays}天 · ${total} 条</b>`;

		this.renderWeekColumn();

		this.gridEl.empty();
		const levelByDate = new Map<string, number>();
		const countByDate = new Map<string, number>();
		for (const c of cells) {
			levelByDate.set(c.date, c.level);
			countByDate.set(c.date, c.count);
		}

		// 网格按“周一为起点”对齐：本周一 ← 今天；最早那周从 gridStart（周一）起
		const curWeekMon = new Date(t0);
		curWeekMon.setDate(t0.getDate() - todayWd);
		const gridStart = new Date(curWeekMon);
		gridStart.setDate(curWeekMon.getDate() - (weeks - 1) * ACTIVITY_COLS);

		// 竖排 7 格 = 一周（周一在顶、周日在底，各列统一），横排为周列；固定正方格铺满可见宽度
		this.gridEl.style.gridAutoFlow = "column";
		this.gridEl.style.gridTemplateRows = `repeat(${ACTIVITY_COLS}, ${CELL_H}px)`;
		this.gridEl.style.gridTemplateColumns = `repeat(${weeks}, ${CELL_H}px)`;
		this.gridEl.style.gap = `${CELL_GAP}px`;

		for (let i = 0; i < spanDays; i++) {
			const day = new Date(gridStart);
			day.setDate(gridStart.getDate() + i);
			const key =
				`${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
			// 列：越靠右越新；行：周一在顶；今天按其星期落在最右列对应行；右侧未来星期留空
			const col = Math.floor(i / ACTIVITY_COLS);
			const row = i % ACTIVITY_COLS;

			const lvl = levelByDate.get(key) ?? 0;
			const cls = key === todayKey
				? "moment-cell today"
				: `moment-cell l${lvl}`;
			const cell = this.gridEl.createDiv({ cls });
			if (lvl > 0) cell.classList.add(`l${lvl}`);
			// 悬停提示：日期 + 条数
			const count = countByDate.get(key) ?? 0;
			cell.dataset.date = `${day.getMonth() + 1}/${day.getDate()}`;
			cell.dataset.count = String(count);
			cell.setAttribute("aria-label",
				(key === todayKey ? "今天" : `${day.getMonth() + 1}月${day.getDate()}日`) +
				` · ${count} 条`);
			// 显式定位到 (行=row+1, 列=col+1)，避免自动排布错位
			cell.style.gridRow = `${row + 1}`;
			cell.style.gridColumn = `${col + 1}`;
			cell.style.height = `${CELL_H}px`;
		}
		this.refreshOnResize();
	}

	/** 右侧星期栏（固定顺序：一在顶、日在底，各列一致） */
	private renderWeekColumn() {
		this.weekEl.empty();
		this.weekEl.style.display = "grid";
		this.weekEl.style.gridTemplateRows = `repeat(${ACTIVITY_COLS}, ${CELL_H}px)`;
		this.weekEl.style.gridAutoFlow = "column";
		this.weekEl.style.gap = `${CELL_GAP}px`;
		for (const wd of WEEKDAY_LABELS) {
			const item = this.weekEl.createDiv({
				cls: "moment-activity-week-item",
				text: wd,
			});
			item.style.height = `${CELL_H}px`;
		}
		this.weekEl.setAttribute("aria-hidden", "true");
	}

	/** 活跃度已渲染内容的签名，用于跳过重复重建 */
	private activitySig = "";

	// 面板宽度变化时重新自适应渲染（纯展示，虚拟列表不重建）
	private refreshTimer: number | null = null;
	private refreshOnResize() {
		if (this.refreshTimer) {
			window.clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = window.setTimeout(() => {
			const prevWeeks = this.lastWeeks;
			const body = this.gridEl.parentElement as HTMLElement;
			const bodyW = (body && body.clientWidth) || 0;
			const weekW = this.weekEl.clientWidth || 16;
			const avail = Math.max(160, bodyW - weekW - 12);
			const slot = CELL_H + CELL_GAP;
			const weeks = Math.max(1, Math.floor((avail + CELL_GAP) / slot));
			if (weeks !== prevWeeks) {
				this.lastWeeks = weeks;
				this.renderActivity();
			}
		}, 250);
	}
	private lastWeeks = 0;

	private renderQuote() {
		const pool = (this.plugin.settings.quotes || []).filter((q) => q.trim());
		if (!pool.length) {
			this.quoteEl.textContent = "";
			this.quoteEl.style.display = "none";
			return;
		}
		this.quoteEl.style.display = "";
		// 按「当天」散列取词：同一天内刷新（库事件 / 心跳）不再让名言乱跳，
		// 但仍然逐日轮换。
		const seed = hashStr(dateParts(new Date()).dateKey + pool.length);
		this.quoteEl.textContent = "“" + pool[seed % pool.length] + "”";
	}

	/**
	 * 分批渲染信息流：先枚举库内真实存在的日文件（新 → 旧）作为队列，
	 * 首屏只渲染最近一批，滚动到底部再拉取下一批，避免一次性读取 / 渲染过长历史。
	 * 刷新（心跳 / 事件）时保留用户已加载到的深度，不会把长列表缩回首屏。
	 *
	 * 与旧实现的关键差异：不再「按天从今天往前盲扫」，而是只在真实存在的
	 * 日文件之间翻页 —— 既不会在数据结束后的空天上无限空转（永远触不到底），
	 * 也保证批次严格按日期倒序追加（不会出现旧的跑到新的前面）。
	 */
	private async renderFeed(fresh = false) {
		const gen = ++this.feedGen;
		this.feedDates = this.store.listDayDates();
		// 重绘期间占住加载位：期间滚动事件不会再插入并发批次
		this.feedLoading = true;
		this.renderFeedFilterBar();
		this.setFeedMore("");

		// 分页窗口：未筛选时按已加载深度保留；筛选时改为按「命中的天数」翻页，
		// 需要时一直向后找够 FEED_BATCH 个命中日（或扫到历史末尾），
		// 避免稀有心情在第一页查无结果而被误报成「没有符合的动态」。
		const filtering = this.moodFilter.size > 0;
		const wantGroups = filtering ? FEED_BATCH : Number.POSITIVE_INFINITY;
		const slotLimit = Math.min(
			filtering
				? Number.POSITIVE_INFINITY
				: Math.max(FEED_BATCH, this.feedRendered),
			this.feedDates.length
		);

		// 先把窗口内的天读成「渲染计划」（只读数据，不改动 DOM）
		const plan: { date: Date; msgs: MomentMessage[] }[] = [];
		let cursor = 0;
		while (
			gen === this.feedGen &&
			cursor < slotLimit &&
			plan.length < wantGroups
		) {
			const d = this.feedDates[cursor++];
			const day = await this.store.readDay(d, fresh);
			if (gen !== this.feedGen) return;
			if (!day || !day.messages.length) continue;
			const msgs = this.filterMsgs([...day.messages].reverse()); // 该天内最新在上
			if (!msgs.length) continue;
			plan.push({ date: d, msgs });
		}
		if (gen !== this.feedGen) return;

		// 与现有分组逐项比对（日期 + 内容签名）：完全一致就跳过重建。
		// 心跳 / 库事件刷新时内容通常没变，跳过可避免整段 DOM 反复销毁重建 ——
		// 那正是滚动 / 静置时「抽动」的主因（重建会让图片全部重新加载）。
		const same =
			plan.length > 0 &&
			plan.length === this.feedGroups.length &&
			plan.every((p, i) => {
				const g = this.feedGroups[i];
				return (
					feedKey(g.date) === feedKey(p.date) &&
					g.sig === feedSig(p.msgs)
				);
			});

		this.feedRendered = cursor;
		this.feedLoading = false;

		if (same) {
			// 内容未变：不碰 DOM，仅刷新哨兵状态与可视窗口
			this.updateFeedMoreState();
			this.scheduleFeedWindow();
			return;
		}

		// 内容有变：记录滚动位置后重建，重建完再还原，减少跳动
		const prevTop = this.contentEl.scrollTop;
		this.feedHost.empty();
		this.feedGroups = [];
		this.feedHasGroup = false;
		for (const p of plan) {
			this.appendFeedGroup(p.date, p.msgs);
			this.feedHasGroup = true;
		}
		if (!this.feedHasGroup) {
			this.feedHost.createDiv({ cls: "moment-empty" }).textContent =
				this.moodFilter.size
					? "没有符合所选心情的动态。"
					: "还没有动态。点右上角 ＋，把此刻随手记下来。";
		}

		await this.fillViewport(fresh);
		if (gen !== this.feedGen) return;
		// 重建后按窗口卸载多余分组，并恢复滚动位置
		this.applyFeedWindow();
		if (prevTop > 0) this.contentEl.scrollTop = prevTop;
		this.updateFeedMoreState();
	}

	/** 拉取并追加下一批（供滚动触底与首屏兜底复用） */
	private async loadMoreFeed(fresh = false) {
		const gen = this.feedGen;
		if (this.feedLoading || this.inOverview) return;
		if (this.feedRendered >= this.feedDates.length) return;
		this.feedLoading = true;
		this.setFeedMore("加载更早的动态…");
		try {
			let added = await this.loadFeedBatch(fresh, gen);
			if (gen !== this.feedGen) return;
			// 整批日文件都无正文时继续补，直到找到内容或翻到队尾
			while (
				added === 0 &&
				!this.feedHasGroup &&
				this.feedRendered < this.feedDates.length
			) {
				added = await this.loadFeedBatch(fresh, gen);
				if (gen !== this.feedGen) return;
			}
		} finally {
			if (gen === this.feedGen) this.feedLoading = false;
		}
		this.updateFeedMoreState();
		// 追加后重算可视窗口：把离视口过远的旧分组卸载掉
		this.scheduleFeedWindow();
	}

	/** 消费队列中接下来的一批日期，返回本批新增分组数。
	 *  未筛选：最多消费 FEED_BATCH 天；筛选：一直向后找，直到凑够 FEED_BATCH
	 *  个命中分组或到达队尾（未命中的天不产生分组，但要消耗游标）。 */
	private async loadFeedBatch(fresh: boolean, gen: number): Promise<number> {
		const filtering = this.moodFilter.size > 0;
		const from = this.feedRendered;
		const slotLimit = Math.min(
			filtering ? Number.POSITIVE_INFINITY : from + FEED_BATCH,
			this.feedDates.length
		);
		let cursor = from;
		let added = 0;
		while (
			gen === this.feedGen &&
			cursor < slotLimit &&
			(!filtering || added < FEED_BATCH)
		) {
			const d = this.feedDates[cursor++];
			const day = await this.store.readDay(d, fresh);
			if (gen !== this.feedGen) return added;
			if (!day || !day.messages.length) continue;
			const msgs = this.filterMsgs([...day.messages].reverse()); // 该天内最新在上
			if (!msgs.length) continue;
			this.appendFeedGroup(d, msgs);
			added++;
			this.feedHasGroup = true;
		}
		if (gen !== this.feedGen) return added;
		this.feedRendered = cursor;
		return added;
	}

	/** 信息流顶部：筛选进行中的提示条（点色块可逐个取消，也可一键清除） */
	private renderFeedFilterBar() {
		const sig = [...this.moodFilter].join("|");
		if (sig === this.feedFilterSig) return; // 未变化则保留现有按钮，避免打断点击
		this.feedFilterSig = sig;
		this.feedHeadEl.empty();
		if (!this.moodFilter.size) return;
		const bar = this.feedHeadEl.createDiv({ cls: "moment-filter-bar" });
		bar.createSpan({ cls: "moment-filter-label", text: "筛选心情" });
		for (const m of this.moodFilter) {
			const chip = bar.createEl("button", {
				cls: "moment-filter-chip",
				text: m,
				attr: { title: "点击移除该筛选" },
			});
			chip.addEventListener("click", (e) => {
				e.stopPropagation();
				this.toggleMoodFilter(m);
			});
		}
		const clear = bar.createEl("button", {
			cls: "moment-filter-clear",
			text: "清除全部",
		});
		clear.addEventListener("click", (e) => {
			e.stopPropagation();
			this.clearMoodFilter();
		});
	}

	/**
	 * 追加一天的分组容器（一天 = 一个自动卸载单元）。
	 * 容器先渲染出内容；离视口过远的分组随后由 applyFeedWindow 卸载，
	 * 卸载时保留其高度占位，因此整页滚动位置不会跳动。
	 */
	private appendFeedGroup(day: Date, msgs: MomentMessage[]) {
		const el = this.feedHost.createDiv({ cls: "moment-feed-group" });
		const entry: FeedGroupEntry = {
			date: day,
			msgs,
			el,
			height: 0,
			rendered: false,
			sig: feedSig(msgs),
		};
		this.feedGroups.push(entry);
		this.mountFeedGroup(entry);
	}

	/** 渲染一个分组的正文：分组头（日期 + 条数）+ 该天全部动态 */
	private renderGroupContent(g: FeedGroupEntry) {
		const dayHead = g.el.createDiv({ cls: "moment-feed-day" });
		const chip = dayHead.createDiv({ cls: "moment-feed-chip" });
		chip.createSpan({ text: fmtHead(g.date) });
		chip.createSpan({ cls: "cnt", text: `${g.msgs.length} 条动态` });
		for (const m of g.msgs) {
			g.el.appendChild(
				new FeedRow(
					m,
					(x) => this.imageRow(x),
					() => this.retract(g.date, m)
				).render(m)
			);
		}
	}

	/** 挂载分组内容；命中高度缓存时先按缓存高度占位，减少重排跳动 */
	private mountFeedGroup(g: FeedGroupEntry) {
		if (g.rendered) return;
		g.rendered = true;
		g.el.removeClass("moment-feed-group--void");
		const cached = this.feedHeights.get(feedKey(g.date));
		g.el.style.height =
			cached && cached.sig === g.sig ? `${cached.h}px` : "";
		g.el.empty();
		this.renderGroupContent(g);
		// 渲染完成，交还给内容自适应高度
		g.el.style.height = "";
	}

	/** 卸载分组内容，但保留其高度占位，保证滚动位置不跳动 */
	private unmountFeedGroup(g: FeedGroupEntry) {
		if (!g.rendered) return;
		const h = g.el.getBoundingClientRect().height;
		g.height = h;
		this.feedHeights.set(feedKey(g.date), { sig: g.sig, h });
		g.el.empty();
		g.el.style.height = `${h}px`;
		g.el.addClass("moment-feed-group--void");
		g.rendered = false;
	}

	/** 滚动接近底部时拉取下一批 */
	private maybeLoadMoreFeed() {
		if (this.inOverview || this.feedLoading) return;
		if (this.feedRendered >= this.feedDates.length) return;
		const el = this.contentEl;
		if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) {
			void this.loadMoreFeed();
		}
	}

	/** 内容不足以产生滚动时继续拉取，直到可滚动或翻到队尾 */
	private async fillViewport(fresh = false) {
		const el = this.contentEl;
		while (
			this.feedRendered < this.feedDates.length &&
			!this.feedLoading &&
			el.scrollHeight <= el.clientHeight + 400
		) {
			const before = this.feedRendered;
			await this.loadMoreFeed(fresh);
			if (this.feedRendered === before) break;
		}
	}

	private setFeedMore(text: string) {
		if (!this.feedMoreEl) return;
		this.feedMoreEl.textContent = text;
		this.feedMoreEl.classList.toggle("show", !!text);
	}

	private updateFeedMoreState() {
		if (this.feedRendered >= this.feedDates.length) {
			this.setFeedMore(this.feedHasGroup ? "没有更早的动态了" : "");
		} else {
			this.setFeedMore("");
		}
	}

	/** 渲染信息流内单条图片：九宫格 / 卡片堆叠，单击放大预览 */
	private imageRow(m: MomentMessage): HTMLElement {
		const wrap = document.createElement("div");
		const mode = this.plugin.settings.imageMode === "stack" ? "stack" : "grid";
		wrap.addClass("moment-post-imgs", mode);
		// 先按原顺序解析为完整资源 URI（跳过找不到的文件）
		const uris: { name: string; uri: string }[] = [];
		for (const img of m.images) {
			const uri = this.resourceUri(img);
			if (uri) uris.push({ name: img, uri });
		}
		const openPreview = (idx: number) =>
			this.previewImages(uris.map((u) => u.uri), idx);

		if (mode === "stack") {
			for (const u of uris) {
				const el = wrap.createEl("img", {
					cls: "moment-post-img",
				}) as HTMLImageElement;
				el.src = u.uri;
				el.addEventListener("click", (e) => {
					e.stopPropagation();
					openPreview(uris.indexOf(u));
				});
			}
			return wrap;
		}

		// 九宫格：最多 9 格（微信风格）；超出部分在第 9 格显示 +N
		const total = uris.length;
		const shown = uris.slice(0, 9);
		shown.forEach((u, i) => {
			const cell = wrap.createDiv({ cls: "moment-grid-cell" });
			const el = cell.createEl("img", {
				cls: "moment-post-img",
			}) as HTMLImageElement;
			el.src = u.uri;
			if (i === shown.length - 1 && total > 9) {
				cell.addClass("more");
				cell.createDiv({ cls: "moment-grid-more", text: `+${total - 9}` });
			}
			cell.addEventListener("click", (e) => {
				e.stopPropagation();
				openPreview(uris.indexOf(u));
			});
		});
		return wrap;
	}

	/** 单击图片：全屏灯箱预览，左右键 / 按钮切换，点击背景或 Esc 关闭 */
	private previewImages(uris: string[], start: number) {
		if (!uris.length) return;
		const overlay = document.createElement("div");
		overlay.addClass("moment-lightbox");
		let idx = Math.max(0, Math.min(uris.length - 1, start));
		const img = overlay.createEl("img") as HTMLImageElement;
		const counter = overlay.createDiv({ cls: "moment-lightbox-count" });
		const show = () => {
			img.src = uris[idx];
			counter.textContent = `${idx + 1} / ${uris.length}`;
		};
		const step = (d: number) => {
			idx = (idx + d + uris.length) % uris.length;
			show();
		};
		const close = () => {
			document.removeEventListener("keydown", onKey, true);
			overlay.remove();
			if (this.lightboxClose === close) this.lightboxClose = null;
			if (this.lightboxEl === overlay) this.lightboxEl = null;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
			else if (uris.length > 1 && e.key === "ArrowLeft") step(-1);
			else if (uris.length > 1 && e.key === "ArrowRight") step(1);
		};
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) close();
		});
		if (uris.length > 1) {
			const prev = overlay.createEl("button", {
				cls: "moment-lightbox-btn left",
			});
			prev.innerHTML = PREV_SVG;
			prev.addEventListener("click", (e) => {
				e.stopPropagation();
				step(-1);
			});
			const next = overlay.createEl("button", {
				cls: "moment-lightbox-btn right",
			});
			next.innerHTML = NEXT_SVG;
			next.addEventListener("click", (e) => {
				e.stopPropagation();
				step(1);
			});
		}
		document.addEventListener("keydown", onKey, true);
		// 同一时刻只保留一个灯箱；记录引用以便视图关闭时一并清理
		this.lightboxClose?.();
		this.lightboxEl = overlay;
		this.lightboxClose = close;
		document.body.appendChild(overlay);
		show();
	}

	/** 把附件相对文件名解析为库内完整路径（YYYY-M-D-….ext → 附件根/YYYY-M/名） */
	private resolveAttachment(ref: string): string {
		if (ref.includes("/") || ref.includes("\\")) return normalizePath(ref);
		const m = ref.match(/^(\d{4}-\d{1,2})-/);
		const monthDir = m ? m[1] : "";
		return monthDir
			? normalizePath(`${attachmentRoot(this.plugin.settings)}/${monthDir}/${ref}`)
			: normalizePath(ref);
	}

	private resourceUri(ref: string): string {
		const f = this.app.vault.getAbstractFileByPath(
			this.resolveAttachment(ref)
		);
		return f instanceof TFile
			? this.app.vault.getResourcePath(f)
			: "";
	}

	/* ---------- 全览 ---------- */
	private overviewRestoreTop = 0;
	private toggleOverview(open: boolean) {
		this.inOverview = open;
		const root = this.contentEl;
		if (open) {
			// 锁定外层整页滚动并回到顶部，确保 full 覆盖层绝对罩住可视区
			this.overviewRestoreTop = root.scrollTop;
			root.scrollTop = 0;
			root.classList.add("moment-overviewing");
		} else {
			root.classList.remove("moment-overviewing");
			root.scrollTop = this.overviewRestoreTop;
			this.onPageScroll();
		}
		this.overviewEl.classList.toggle("open", open);
		if (open) this.renderOverview();
	}

	private async renderOverview() {
		const gen = ++this.overviewGen;
		for (const [lvl, el] of this.segEls)
			el.classList.toggle("active", lvl === this.aggr);
		this.ovLabelEl.textContent = "再次下拉 / 滚动到顶向下可退出全览";
		this.ovScrollEl.empty();
		const units = await this.overview.build(this.aggr, 8);
		// 快速连点档位时，先发出的构建可能后返回：丢弃过期结果
		if (gen !== this.overviewGen) return;
		if (!units.length) {
			this.ovScrollEl.createDiv({ cls: "moment-empty" }).textContent =
				"这个时间跨度里还没有内容。";
			return;
		}
		for (const u of units) this.ovScrollEl.appendChild(this.renderUnit(u));
	}

	private renderUnit(u: OverviewUnit): HTMLElement {
		const row = document.createElement("div");
		row.addClass("moment-ov-day");
		const dl = row.createDiv({ cls: "moment-ov-dl" });
		if (u.day) {
			// dateKey 形如 "2026-9-10"，直接拆数字，避免 Date 解析非补零串的实现差异
			const [, mo, dd] = u.day.date.split("-").map(Number);
			dl.createDiv({ cls: "d", text: String(dd) });
			dl.createDiv({ cls: "m", text: `${mo}月` });
		} else {
			dl.createDiv({ cls: "m", text: u._label });
		}
		const thumbs = row.createDiv({ cls: "moment-ov-thumbs" });
		const images = u.day ? u.day.thumbs : u.days?.flatMap((d) => d.thumbs) || [];
		const hasText = u.day
			? u.day.messages.length > 0
			: (u.days?.some((d) => d.messages.length) ?? false);

		if (u.day) {
			// 天：网格，最多铺 6 格缩略图 + 文本
			thumbs.style.gridTemplateColumns = "repeat(3,1fr)";
			images.slice(0, 6).forEach((img) => {
				thumbs.appendChild(this.makeThumb(img));
			});
			if (hasText) {
				// 文字动态以淡色块表示
				const t = thumbs.createDiv({ cls: "moment-ov-thumb dim text" });
				t.textContent = "✎";
			}
		} else {
			// 周/月/年：单卡片，显示条数 + 缩略图展平
			const n = u.days?.length ?? 0;
			row.removeClass("moment-ov-day");
			row.addClass("moment-ov-unit");
			row.createDiv({
				text: `${u._label} · ${n} 天 · ${u.thumbCount ?? 0} 图`,
			});
			const t2 = row.createDiv({ cls: "moment-ov-thumbs" });
			t2.style.gridTemplateColumns = "repeat(6,1fr)";
			const allImgs = u.days?.flatMap((d) => d.thumbs).slice(0, 12) || [];
			allImgs.forEach((img) => t2.appendChild(this.makeThumb(img)));
		}
		return row;
	}

	private makeThumb(ref: string): HTMLElement {
		const wrap = document.createElement("div");
		wrap.addClass("moment-ov-thumb");
		const uri = this.resourceUri(ref);
		if (uri) {
			const img = wrap.createEl("img") as HTMLImageElement;
			img.loading = "lazy";
			img.src = uri;
		} else {
			wrap.addClass("dim");
		}
		return wrap;
	}

	/* ---------- 撤回 / 重新编辑 ---------- */
	private retract(date: Date, msg: MomentMessage) {
		new ConfirmModal(
			this.app,
			"撤回这条动态？",
			"撤回后可从底部提示条点「重新编辑」继续。文件内该条会被移除，配图文件本身保留。",
			async (ok) => {
				if (!ok) return;
				const removed = await this.store.removeMessage(date, msg);
				if (!removed) {
					new Notice("未找到该动态");
					return;
				}
				this.retracted = { date, msg };
				this.showUndo();
				await this.refresh();
			}
		).open();
	}

	private showUndo() {
		if (!this.undoEl) {
			this.undoEl = document.createElement("div");
			this.undoEl.addClass("moment-undo");
			this.undoEl.innerHTML = UNDO_SVG;
			const span = document.createElement("span");
			span.textContent = "已撤回 · 点击重新编辑";
			this.undoEl.appendChild(span);
			this.undoEl.addEventListener("click", () => {
				if (!this.retracted) return;
				const { msg } = this.retracted;
				this.openPublish({
					text: msg.text,
					mood: msg.mood,
					images: msg.images,
				});
			});
			document.body.appendChild(this.undoEl);
		}
		this.undoEl.classList.add("show");
	}

	private clearUndo() {
		this.retracted = null;
		this.undoEl?.classList.remove("show");
	}

	/* ---------- 发布 / 重新编辑 ---------- */
	private openPublish(prefill?: {
		text?: string;
		mood?: string;
		images?: string[];
	}) {
		const overlay = document.createElement("div");
		overlay.addClass("moment-publish");
		const card = overlay.createDiv({ cls: "moment-publish-card" });

		const head = card.createDiv({ cls: "moment-publish-head" });
		const close = head.createEl("button", { cls: "moment-publish-close" });
		close.textContent = "×";
		close.addEventListener("click", () => overlay.remove());
		head.createDiv({ cls: "moment-publish-title", text: "此刻 · 发布" });
		const send = head.createEl("button", {
			cls: "moment-publish-send",
			text: "发布",
		});

		const textarea = card.createEl("textarea", {
			cls: "moment-publish-text",
			attr: { placeholder: "此刻在想什么…" },
		}) as HTMLTextAreaElement;
		if (prefill?.text) textarea.value = prefill.text;

		// 选中心情 + 新附件 + 保留（重新编辑）的旧附件
		let mood: string | undefined = prefill?.mood || undefined;
		let files: File[] = [];
		let keep: string[] = [...(prefill?.images || [])];

		const addFiles = (added: File[]) => {
			let changed = false;
			added.forEach((f) => {
				if (f.type && !f.type.startsWith("image/")) return;
				files.push(f);
				changed = true;
			});
			if (changed) renderImgs();
		};

		// 心情：下拉列表（含「新建心情」快捷项）
		const moodCandidates = () =>
			(this.plugin.settings.moods || []).filter((m) => m.trim()).length
				? this.plugin.settings.moods.filter((m) => m.trim())
				: DEFAULT_MOODS;
		const row = card.createDiv({ cls: "moment-publish-row" });
		row.createSpan({ cls: "moment-publish-row-label", text: "心情" });
		const sel = row.createEl("select", {
			cls: "moment-mood-select",
		}) as HTMLSelectElement;
		const buildOptions = (selected?: string) => {
			sel.empty();
			sel.createEl("option", { value: "", text: "‒ 不选择 ‒" });
			moodCandidates().forEach((m) =>
				sel.createEl("option", { value: m, text: m })
			);
			sel.createEl("option", { value: NEW_MOOD, text: "＋ 新建心情…" });
			sel.value = selected && moodCandidates().includes(selected) ? selected : "";
		};
		buildOptions(prefill?.mood);
			sel.addEventListener("change", () => {
			if (sel.value === NEW_MOOD) {
				sel.value = "";
				const modal = new NewMoodModal(this.plugin, (name) => {
					if (!this.plugin.settings.moods.includes(name))
						this.plugin.settings.moods.push(name);
					this.plugin.saveSettings();
					buildOptions(name);
					mood = name;
				}, () => {
					buildOptions();
					mood = undefined;
				});
				modal.open();
				return;
			}
			mood = sel.value || undefined;
		});

		// 图片预览：保留图（重新编辑的旧附件） + 新选图
		const imgs = card.createDiv({ cls: "moment-publish-imgs" });
		const renderImgs = () => {
			imgs.empty();
			keep.forEach((name, i) => {
				const url = this.resourceUri(name);
				if (!url) return;
				const p = imgs.createEl(
					"img",
					{ cls: "moment-pending-img" }
				) as HTMLImageElement;
				p.src = url;
				p.addEventListener("click", () => {
					keep.splice(i, 1);
					renderImgs();
				});
			});
			files.forEach((f, i) => {
				const url = URL.createObjectURL(f);
				const p = imgs.createEl(
					"img",
					{ cls: "moment-pending-img" }
				) as HTMLImageElement;
				p.src = url;
				p.addEventListener("click", () => {
					files.splice(i, 1);
					renderImgs();
				});
			});
		};

		// 文件选择按钮
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.accept = "image/*";
		fileInput.multiple = true;
		fileInput.style.display = "none";
		overlay.appendChild(fileInput);
		fileInput.addEventListener("change", () => {
			if (fileInput.files) addFiles(Array.from(fileInput.files));
			fileInput.value = "";
		});

		const footer = card.createDiv({ cls: "moment-publish-footer" });
		const imgBtn = footer.createEl("button", { cls: "moment-icon-btn" });
		setIcon(imgBtn, "image");
		imgBtn.addEventListener("click", () => fileInput.click());

		// 发布：右上角「发布」按钮
		send.addEventListener(
			"click",
			() =>
				this.publish(
					textarea.value,
					mood,
					files,
					keep,
					() => {
						overlay.remove();
						this.clearUndo();
					}
				)
		);

		const hint = footer.createDiv({ cls: "moment-publish-hint" });
		hint.textContent = "支持拖入或粘贴图片";

		// 拖入上传
		card.addEventListener("dragover", (e) => {
			e.preventDefault();
			card.addClass("dragging");
		});
		card.addEventListener("dragleave", (e) => {
			if (!card.contains(e.relatedTarget as Node))
				card.removeClass("dragging");
		});
		card.addEventListener("drop", (e) => {
			e.preventDefault();
			card.removeClass("dragging");
			if (e.dataTransfer?.files?.length)
				addFiles(Array.from(e.dataTransfer.files));
		});

		// 复制粘贴上传图片（纯文本仍正常输入）
		card.addEventListener("paste", (e) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			const pasted: File[] = [];
			for (let i = 0; i < items.length; i++) {
				const it = items[i];
				if (it.type && it.type.startsWith("image/")) {
					const f = it.getAsFile();
					if (f) pasted.push(f);
				}
			}
			if (pasted.length) {
				e.preventDefault();
				addFiles(pasted);
			}
		});

		this.contentEl.appendChild(overlay);
		textarea.focus();
	}

	private async publish(
		raw: string,
		mood: string | undefined,
		files: File[],
		keep: string[],
		done: () => void
	) {
		const text = raw.trim();
		if (!text && !files.length && !keep.length) {
			new Notice("写点什么再发布吧");
			return;
		}
		const now = new Date();
		const images: string[] = [...keep];
		try {
			if (files.length) {
					await this.store.ensureAttachmentRoot();
					for (let i = 0; i < files.length; i++) {
						const f = files[i];
						const ext = "." + (f.name.split(".").pop() || "png");
						const buf = await f.arrayBuffer();
						// 同一秒多选多张时附加序号，避免文件名冲突
						const suffix = files.length > 1 ? `-${i}` : "";
						const dest = attachmentPath(
							this.plugin.settings,
							now,
							ext,
							suffix
						);
						// 使用 vault，适配库内根目录
						await this.store.ensureDir(
							dest.substring(0, dest.lastIndexOf("/"))
						);
						await this.app.vault.createBinary(dest, buf);
						images.push(dest.split("/").pop()!);
					}
				}
			const msg: MomentMessage = {
				time: fmtTime(now),
				mood,
				text,
				images,
			};
			await this.store.append(now, msg);
			done();
			new Notice("已记录此刻");
			await this.refresh();
		} catch (e) {
			console.error(e);
			new Notice("发布失败：" + e);
		}
	}
}

const DEFAULT_SIGN = "把日子过成想要的样子";

/** 快速新建心情的弹窗 */
class NewMoodModal extends Modal {
	constructor(
		plugin: MomentPlugin,
		private done: (name: string) => void,
		private canceled: () => void
	) {
		super(plugin.app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "新建心情" });
		const input = contentEl.createEl("input", {
			type: "text",
			placeholder: "输入新心情…",
		}) as HTMLInputElement;
		input.addClass("moment-mood-new-input");
		input.focus();

		const save = () => {
			const v = input.value.trim();
			if (!v) {
				this.canceled();
				this.close();
				return;
			}
			this.done(v);
			this.close();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				save();
			}
			if (e.key === "Escape") {
				this.canceled();
				this.close();
			}
		});

		const btns = contentEl.createDiv({
			cls: "modal-button-container",
		});
		new ButtonComponent(btns)
			.setButtonText("取消")
			.setWarning()
			.onClick(() => {
				this.canceled();
				this.close();
			});
		new ButtonComponent(btns)
			.setButtonText("保存")
			.setCta()
			.onClick(save);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** 通用确认弹窗（返回 true=确认 / false=取消） */
class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private message: string,
		private result: (ok: boolean) => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.message });
		const btns = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(btns)
			.setButtonText("取消")
			.onClick(() => {
				this.result(false);
				this.close();
			});
		new ButtonComponent(btns)
			.setButtonText("确认撤回")
			.setWarning()
			.onClick(() => {
				this.result(true);
				this.close();
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}

function fmtTime(d: Date): string {
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}

/** 信息流的一行语义 */
class FeedRow {
	constructor(
		public data: MomentMessage,
		private imgRenderer: (m: MomentMessage) => HTMLElement,
		private onDelete?: () => void
	) {}

	render(m: MomentMessage): HTMLElement {
		const el = document.createElement("div");
		el.addClass("moment-post");
		// 左侧头像（相机图标，区别于身份照）
		const avatar = el.createDiv({ cls: "moment-avatar" });
		avatar.innerHTML = CAMERA_SVG;
		// 右侧内容体
		const body = el.createDiv({ cls: "moment-body" });
		const meta = body.createDiv({ cls: "moment-post-meta" });
		meta.createDiv({ cls: "tm", text: m.time });
		if (m.mood) {
			const mm = meta.createDiv({ cls: "moment-mood", text: m.mood });
			mm.textContent = m.mood;
		}
		if (this.onDelete) {
			const del = meta.createDiv({ cls: "moment-delete" });
			del.innerHTML = DEL_SVG;
			del.setAttribute("title", "撤回");
			del.addEventListener("click", (e) => {
				e.stopPropagation();
				this.onDelete?.();
			});
		}
		if (m.text) {
			const t = body.createDiv({ cls: "moment-post-text", text: m.text });
			t.textContent = m.text;
		}
		if (m.images.length) {
			body.appendChild(this.imgRenderer(m));
		}
		return el;
	}
}

/** 头像用内联相机 SVG（不使用表情，图标化） */
const CAMERA_SVG =
	`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ` +
	`stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
	`<path d="M4 8h2l1.5-2h9L18 8h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/>` +
	`<circle cx="12" cy="13.5" r="3.2"/></svg>`;

/** 全览入口：九宫格图标 */
const GRID_SVG =
	`<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ` +
	`stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
	`<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>` +
	`<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;

/** 退出全览：叉号图标 */
const EXIT_SVG =
	`<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ` +
	`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
	`<path d="M6 6l12 12M18 6L6 18"/></svg>`;

/** 回到顶部：向上箭头图标 */
const TOP_SVG =
	`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ` +
	`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
	`<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>`;

/** 预览上一张：左箭头 */
const PREV_SVG =
	`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ` +
	`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
	`<path d="m15 18-6-6 6-6"/></svg>`;

/** 预览下一张：右箭头 */
const NEXT_SVG =
	`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ` +
	`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
	`<path d="m9 18 6-6-6-6"/></svg>`;

/** 撤回：垃圾桶图标 */
const DEL_SVG =
	`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ` +
	`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
	`<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>` +
	`<path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/></svg>`;

/** 撤回提示条：回到箭头图标 */
const UNDO_SVG =
	`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ` +
	`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
	`<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;

/** 日期分组头文案：今天 / 昨天 / 前天 / M月D日 */
function fmtHead(d: Date): string {
	const now = new Date();
	const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	const diff = Math.round((t0.getTime() - d0.getTime()) / 86400000);
	if (diff === 0) return "今天";
	if (diff === 1) return "昨天";
	if (diff === 2) return "前天";
	return `${d.getMonth() + 1}月${d.getDate()}日`;
}