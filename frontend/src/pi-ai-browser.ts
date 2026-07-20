import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";

export class EventStream<T, R = T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiting: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;
  private readonly resultPromise: Promise<R>;
  private resolveResult!: (value: R) => void;

  constructor(
    private readonly isComplete: (event: T) => boolean,
    private readonly extractResult: (event: T) => R,
  ) {
    this.resultPromise = new Promise((resolve) => { this.resolveResult = resolve; });
  }

  push(event: T): void {
    if (this.ended) return;
    if (this.isComplete(event)) {
      this.ended = true;
      this.resolveResult(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result?: R): void {
    this.ended = true;
    if (result !== undefined) this.resolveResult(result);
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length) yield this.queue.shift()!;
      else if (this.ended) return;
      else {
        const next = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }

  result(): Promise<R> {
    return this.resultPromise;
  }
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error(`Unexpected terminal event: ${event.type}`);
      },
    );
  }
}

export const createAssistantMessageEventStream = (): AssistantMessageEventStream => new AssistantMessageEventStream();

export function validateToolArguments(tool: { parameters: object; name: string }, toolCall: ToolCall): unknown {
  const argumentsCopy = structuredClone(toolCall.arguments);
  Value.Convert(tool.parameters as never, argumentsCopy);
  const validator = Compile(tool.parameters as never);
  if (validator.Check(argumentsCopy)) return argumentsCopy;
  const details = [...validator.Errors(argumentsCopy)].map((error) => `${error.instancePath || "root"}: ${error.message}`).join("; ");
  throw new Error(`Validation failed for tool "${tool.name}": ${details}`);
}

export function parseStreamingJson(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    for (const suffix of ["}", "\"}", "]}", "\"]}"]) {
      try {
        return JSON.parse(value + suffix) as Record<string, unknown>;
      } catch {
        // Continue trying bounded completions.
      }
    }
    return {};
  }
}

export function streamSimple(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const error: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "prompt-agent-proxy",
      provider: "prompt-agent",
      model: "unconfigured",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage: "A Prompt Agent proxy stream function is required.",
      timestamp: Date.now(),
    };
    stream.push({ type: "error", reason: "error", error });
    stream.end();
  });
  return stream;
}

export async function completeSimple(): Promise<AssistantMessage> {
  return streamSimple().result();
}
