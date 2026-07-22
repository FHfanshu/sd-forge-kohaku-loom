import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createForgeAgentTools, type ForgeAgentTool, type ForgeToolFactoryOptions, type ForgeToolName, forgeToolPermission } from "./forge-tools";
import { createPromptToolkitTool } from "./prompt-toolkit";

export interface ToolExecutionContext {
  sessionId: string;
  requestId: string;
  signal?: AbortSignal;
}

export class PromptAgentToolRegistry {
  private readonly tools = new Map<string, AgentTool<any>>();

  register(tool: AgentTool<any>): void {
    if (this.tools.has(tool.name)) throw new Error(`Agent tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool<any> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown agent tool: ${name}`);
    return tool;
  }

  list(): AgentTool<any>[] {
    return [...this.tools.values()];
  }

  permission(name: string): "read" | "write" | null {
    const tool = this.tools.get(name) as ForgeAgentTool | undefined;
    return tool?.permission ?? forgeToolPermission(name);
  }
}

export function createForgeToolRegistry(options: ForgeToolFactoryOptions = {}): PromptAgentToolRegistry {
  const registry = new PromptAgentToolRegistry();
  for (const tool of createForgeAgentTools(options)) registry.register(tool);
  registry.register(createPromptToolkitTool());
  return registry;
}

export type { ForgeToolName };
