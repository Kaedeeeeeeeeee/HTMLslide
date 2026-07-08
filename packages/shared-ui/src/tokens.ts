export type InspectorTabId = "outline" | "design" | "notes" | "qa" | "export";
export type QaSeverityId = "error" | "warning" | "suggestion";
export type ToolbarActionId = "generate" | "check" | "export" | "present";

export const inspectorTabLabels: Record<InspectorTabId, string> = {
  outline: "Outline",
  design: "Design",
  notes: "Notes",
  qa: "QA",
  export: "Export"
};

export const qaSeverityLabels: Record<QaSeverityId, string> = {
  error: "Errors",
  warning: "Warnings",
  suggestion: "Suggestions"
};

export const qaSeverityTones: Record<QaSeverityId, "danger" | "warning" | "neutral"> = {
  error: "danger",
  warning: "warning",
  suggestion: "neutral"
};

export const toolbarActionLabels: Record<ToolbarActionId, string> = {
  generate: "Generate",
  check: "Check",
  export: "Export",
  present: "Present"
};
