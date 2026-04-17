import { resolve } from "node:path";

import pino from "pino";

const log = pino({ name: "pi-worker" });

const DEFAULT_PI_AGENT_PATH = resolve(import.meta.dir, "../src/pi-agent-cli.ts");

export interface PiWorkerOptions {
	cwd: string;
	piAgentPath?: string;
	onEvent?: (event: PiWorkerEvent) => void;
}

export type PiWorkerEvent =
	| { type: "session_event"; event: Record<string, unknown> }
	| { type: "outbound_message"; text: string }
	| { type: "done"; result: string }
	| { type: "error"; message: string };

export class PiWorker {
	private readonly cwd: string;
	private readonly piAgentPath: string;
	private readonly onEvent?: (event: PiWorkerEvent) => void;
	private subprocess: Bun.Subprocess | null = null;

	constructor(options: PiWorkerOptions) {
		this.cwd = options.cwd;
		this.piAgentPath = options.piAgentPath ?? DEFAULT_PI_AGENT_PATH;
		this.onEvent = options.onEvent;
	}

	async run(task: string): Promise<string> {
		if (this.subprocess) {
			throw new Error("PiWorker already running");
		}

		this.subprocess = Bun.spawn(["bun", "run", this.piAgentPath, "--task", task], {
			cwd: this.cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});

		let finalResult = "";
		let topLevelError: string | null = null;
		let stdoutBuffer = "";
		let stderrText = "";

		const stdoutStream = this.subprocess.stdout;
		const stderrStream = this.subprocess.stderr;
		if (!stdoutStream || typeof stdoutStream === "number") {
			throw new Error("Failed to open Pi worker stdout");
		}
		if (!stderrStream || typeof stderrStream === "number") {
			throw new Error("Failed to open Pi worker stderr");
		}

		const stdoutReader = stdoutStream.getReader();
		const stderrReader = stderrStream.getReader();
		const decoder = new TextDecoder();
		const stderrDecoder = new TextDecoder();

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) {
				return;
			}

			let parsed: PiWorkerEvent;
			try {
				parsed = JSON.parse(trimmed) as PiWorkerEvent;
			} catch {
				parsed = { type: "outbound_message", text: trimmed };
			}

			if (parsed.type === "done") {
				finalResult = parsed.result;
			}
			if (parsed.type === "error") {
				topLevelError = parsed.message;
			}

			this.onEvent?.(parsed);
		};

		const readStdout = async () => {
			while (true) {
				const { done, value } = await stdoutReader.read();
				if (done) {
					break;
				}
				stdoutBuffer += decoder.decode(value, { stream: true });
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) {
					processLine(line);
				}
			}
		};

		const readStderr = async () => {
			while (true) {
				const { done, value } = await stderrReader.read();
				if (done) {
					break;
				}
				stderrText += stderrDecoder.decode(value, { stream: true });
			}
		};

		await Promise.all([readStdout(), readStderr(), this.subprocess.exited]);
		if (stdoutBuffer.trim()) {
			processLine(stdoutBuffer);
		}

		const exitCode = await this.subprocess.exited;
		this.subprocess = null;

		if (exitCode !== 0) {
			throw new Error(topLevelError ?? (stderrText.trim() || `Pi worker exited with code ${exitCode}`));
		}
		if (topLevelError) {
			throw new Error(topLevelError);
		}

		return finalResult;
	}

	stop(): void {
		if (!this.subprocess) {
			return;
		}
		log.info("terminating Pi worker subprocess");
		this.subprocess.kill();
		this.subprocess = null;
	}
}
