export type HtmlslideMcpTool =
  | "read_deck"
  | "check_deck"
  | "export_deck"
  | "list_slides"
  | "read_slide"
  | "write_slide";

export type ToolSafety = "read-only" | "project-write";

export type ToolDescriptor = {
  name: HtmlslideMcpTool;
  safety: ToolSafety;
  description: string;
};

export const htmlslideTools: ToolDescriptor[] = [
  {
    name: "read_deck",
    safety: "read-only",
    description: "Read deck.json and return normalized project metadata."
  },
  {
    name: "check_deck",
    safety: "read-only",
    description: "Run HTMLslide checks and return a machine-readable report."
  },
  {
    name: "export_deck",
    safety: "project-write",
    description: "Export PDF, HTML, thumbnails, and deckpkg artifacts inside the project exports folder."
  },
  {
    name: "list_slides",
    safety: "read-only",
    description: "List slide ids, titles, sources, notes, and durations."
  },
  {
    name: "read_slide",
    safety: "read-only",
    description: "Read one slide source fragment and notes."
  },
  {
    name: "write_slide",
    safety: "project-write",
    description: "Write one slide source fragment within the deck project boundary."
  }
];

export const isProjectRelativePathSafe = (relativePath: string): boolean => {
  if (relativePath.startsWith("/") || relativePath.includes("\\")) {
    return false;
  }
  return !relativePath.split("/").some((part) => part === "..");
};

