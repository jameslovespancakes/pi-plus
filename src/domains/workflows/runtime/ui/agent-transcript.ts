import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { AgentTranscript } from "../live-agent.ts";

/** Native pi transcript components, driven by the child session's own messages. */
export class AgentTranscriptView {
  private readonly components = new WeakMap<object, Component>();
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private readonly results = new Map<string, object>();

  render(transcript: AgentTranscript, width: number, tui: TUI, cwd: string): string[] {
    const messages = transcript.streaming && !transcript.messages.includes(transcript.streaming)
      ? [...transcript.messages, transcript.streaming] : transcript.messages;
    const rows: string[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        let component = this.components.get(message);
        if (!component) {
          const text = typeof message.content === "string" ? message.content
            : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
          component = new UserMessageComponent(text);
          this.components.set(message, component);
        }
        rows.push(...component.render(width));
      } else if (message.role === "assistant") {
        // Streaming messages can be mutated by pi; update the native component every render.
        let component = this.components.get(message) as AssistantMessageComponent | undefined;
        if (!component) {
          component = new AssistantMessageComponent(message, false);
          this.components.set(message, component);
        }
        component.updateContent(message, message === transcript.streaming);
        rows.push(...component.render(width));
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          let tool = this.tools.get(part.id);
          if (!tool) {
            tool = new ToolExecutionComponent(part.name, part.id, part.arguments, { showImages: false }, undefined, tui, cwd);
            this.tools.set(part.id, tool);
          }
          tool.updateArgs(part.arguments);
          if (message !== transcript.streaming) tool.setArgsComplete();
          const update = transcript.toolUpdates?.get(part.id);
          if (update && this.results.get(part.id) !== update) {
            tool.updateResult({ ...update.result, isError: update.isError }, update.isPartial);
            this.results.set(part.id, update);
          }
          const result = messages.find((candidate) => candidate.role === "toolResult" && candidate.toolCallId === part.id);
          if (result?.role === "toolResult" && this.results.get(part.id) !== result) {
            tool.updateResult(result);
            this.results.set(part.id, result);
          }
          rows.push(...tool.render(width));
        }
      }
    }
    return rows;
  }
}
