import type { AssistantMessage } from "@earendil-works/pi-ai";

/** How long the fps window is: the rate over the frames written in the last second. */
const FPS_WINDOW_MS = 1000;
/** A displayed fps whose window saw no frame is the last value: after this long it is drawn dim. */
const FPS_STALE_MS = 2500;
/** The refresh of a running turn: one frame a second updates the elapsed time and the live rate. */
const REFRESH_MS = 1000;
/** Below this much generation time a rate is noise: one token after 10 ms would read as 100 tok/s. */
const MIN_RATE_SECONDS = 0.5;
/**
 * Characters per output token of the streamed estimate. It is used only while a provider streams no usage counts
 * (most report them with the final chunk): the estimate is not shown as such on screen, it only fills the live rate.
 */
const CHARS_PER_TOKEN = 4;

/** Which meters the footer draws, from settings. */
export interface FooterMeterDisplay {
	showFps: boolean;
	showTokenRate: boolean;
	showTurnTime: boolean;
}

/** The meters as the footer draws them; `undefined` hides a meter. */
export interface FooterMeterValues {
	fps: number | undefined;
	/** The fps window saw no frame: the value is the last one, drawn dim. */
	fpsStale: boolean;
	tokenRate: number | undefined;
	/** The rate is measured as the assistant streams, rather than averaged over the turn. */
	tokenRateLive: boolean;
	turnSeconds: number | undefined;
	/** The turn is running: its time counts on, rather than being the last turn's. */
	turnRunning: boolean;
}

export interface FooterMetersOptions {
	/** Frames written by the TUI so far; it only grows, except across a renderer swap. */
	getFrameCount: () => number;
	/** Ask for a frame: the once-a-second refresh of a running turn. */
	requestRender: () => void;
	/** Clock in milliseconds; injected by tests. */
	now?: () => number;
}

/**
 * Output tokens of a streamed assistant message and how they were counted. Providers that report usage while they
 * stream (the count is in every partial message) are taken at their word; the others get a character estimate of the
 * text and thinking generated so far. Tool-call arguments are left out of the estimate: they stream as JSON, and the
 * estimate only needs to move with the text.
 */
export function countOutputTokens(message: AssistantMessage): { tokens: number; estimated: boolean } {
	if (message.usage.output > 0) return { tokens: message.usage.output, estimated: false };
	let characters = 0;
	for (const block of message.content) {
		if (block.type === "text") characters += block.text.length;
		else if (block.type === "thinking") characters += block.thinking.length;
	}
	return { tokens: Math.ceil(characters / CHARS_PER_TOKEN), estimated: true };
}

/**
 * The footer's live meters: frames per second, output tokens per second and the turn's time.
 *
 * The fps meter samples a frame counter when the footer is drawn, so it needs no timer and adds no frame. A running
 * turn gets one interval, which asks for one frame a second: exactly the refresh the elapsed time and the live rate
 * need, and none at all while Pi is idle.
 */
export class FooterMeters {
	private readonly getFrameCount: () => number;
	private readonly requestRender: () => void;
	private readonly now: () => number;

	private showFps = false;
	private showTokenRate = true;
	private showTurnTime = true;

	/** The frames counted at the start of the fps window; `undefined` until the first sample. */
	private frameCountAtSample: number | undefined;
	private frameSampleAt = 0;
	private fps: number | undefined;
	private fpsWindowIdle = true;

	private turnStartAt: number | undefined;
	private turnRunning = false;
	private lastTurnSeconds: number | undefined;
	private turnOutputTokens = 0;
	private turnStreamMs = 0;

	/** When the current assistant message's first token streamed in. */
	private messageStartedAt: number | undefined;
	private messageOutputTokens = 0;
	private streaming = false;
	/** The rate to draw when no message streams: the last message's, or the last turn's average. */
	private settledRate: number | undefined;

	private refreshTimer: NodeJS.Timeout | undefined;

	constructor(options: FooterMetersOptions) {
		this.getFrameCount = options.getFrameCount;
		this.requestRender = options.requestRender;
		this.now = options.now ?? Date.now;
	}

	setDisplay(display: FooterMeterDisplay): void {
		this.showFps = display.showFps;
		this.showTokenRate = display.showTokenRate;
		this.showTurnTime = display.showTurnTime;
		this.syncRefreshTimer();
	}

	/** A turn started: its time counts from here, and its token rate from its first streamed token. */
	turnStarted(): void {
		this.turnStartAt = this.now();
		this.turnRunning = true;
		this.turnOutputTokens = 0;
		this.turnStreamMs = 0;
		this.messageStartedAt = undefined;
		this.messageOutputTokens = 0;
		this.streaming = false;
		this.syncRefreshTimer();
	}

	/** A turn ended: the footer keeps its time and its average rate, computed from the tokens it generated. */
	turnEnded(): void {
		if (!this.turnRunning) return;
		const now = this.now();
		this.turnRunning = false;
		this.streaming = false;
		this.messageStartedAt = undefined;
		this.lastTurnSeconds = this.turnStartAt === undefined ? undefined : (now - this.turnStartAt) / 1000;
		if (this.turnOutputTokens > 0 && this.turnStreamMs >= MIN_RATE_SECONDS * 1000) {
			this.settledRate = this.turnOutputTokens / (this.turnStreamMs / 1000);
		}
		this.syncRefreshTimer();
	}

	/** The agent settled: a turn that never reported its end (an abort) stops counting. */
	settled(): void {
		this.turnEnded();
	}

	/** An assistant message streamed: its generated tokens move the live rate. */
	assistantStreaming(message: AssistantMessage): void {
		const { tokens } = countOutputTokens(message);
		if (tokens > 0 && this.messageStartedAt === undefined) this.messageStartedAt = this.now();
		this.messageOutputTokens = tokens;
		this.streaming = true;
	}

	/** An assistant message ended: its final token count and generation time go into the turn. */
	assistantMessageEnded(message: AssistantMessage): void {
		this.streaming = false;
		const { tokens } = countOutputTokens(message);
		const startedAt = this.messageStartedAt;
		this.messageStartedAt = undefined;
		this.messageOutputTokens = tokens;
		if (startedAt === undefined) return;
		const now = this.now();
		const elapsedMs = Math.max(0, now - startedAt);
		this.turnOutputTokens += tokens;
		this.turnStreamMs += elapsedMs;
		if (tokens > 0 && elapsedMs >= MIN_RATE_SECONDS * 1000) {
			this.settledRate = tokens / (elapsedMs / 1000);
		}
	}

	values(): FooterMeterValues {
		const now = this.now();

		let fps: number | undefined;
		let fpsStale = true;
		if (this.showFps) {
			this.sampleFrames(now);
			fps = this.fps ?? 0;
			fpsStale = this.fpsWindowIdle || now - this.frameSampleAt > FPS_STALE_MS;
		}

		let tokenRate: number | undefined;
		let tokenRateLive = false;
		if (this.showTokenRate) {
			if (this.streaming && this.messageStartedAt !== undefined) {
				const seconds = (now - this.messageStartedAt) / 1000;
				if (seconds >= MIN_RATE_SECONDS) {
					tokenRate = this.messageOutputTokens / seconds;
					tokenRateLive = true;
				}
			}
			if (tokenRate === undefined) tokenRate = this.settledRate;
		}

		let turnSeconds: number | undefined;
		if (this.showTurnTime) {
			turnSeconds =
				this.turnRunning && this.turnStartAt !== undefined ? (now - this.turnStartAt) / 1000 : this.lastTurnSeconds;
		}

		return { fps, fpsStale, tokenRate, tokenRateLive, turnSeconds, turnRunning: this.turnRunning };
	}

	dispose(): void {
		this.turnRunning = false;
		this.syncRefreshTimer();
	}

	/** The frames written in the last window: a rate needs a whole second, so shorter windows keep the last one. */
	private sampleFrames(now: number): void {
		const count = this.getFrameCount();
		const sampledCount = this.frameCountAtSample;
		if (sampledCount === undefined || count < sampledCount) {
			// The first sample, or a renderer swap, whose TUI counts its frames from zero.
			this.frameCountAtSample = count;
			this.frameSampleAt = now;
			return;
		}
		const elapsed = now - this.frameSampleAt;
		if (elapsed < FPS_WINDOW_MS) return;
		const frames = count - sampledCount;
		this.fps = (frames * 1000) / elapsed;
		this.fpsWindowIdle = frames === 0;
		this.frameCountAtSample = count;
		this.frameSampleAt = now;
	}

	private syncRefreshTimer(): void {
		const wanted = this.turnRunning && (this.showTokenRate || this.showTurnTime);
		if (!wanted) {
			if (this.refreshTimer) {
				clearInterval(this.refreshTimer);
				this.refreshTimer = undefined;
			}
			return;
		}
		if (this.refreshTimer) return;
		this.refreshTimer = setInterval(() => this.requestRender(), REFRESH_MS);
	}
}
