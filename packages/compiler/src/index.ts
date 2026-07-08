import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { buildDeckHtml, type RenderDeck } from "@htmlslide/renderer";

export type CompilerSlideInput = {
  id: string;
  title: string;
  sourcePath: string;
  notesPath?: string;
  durationSec?: number;
};

export type CompilerProjectInput = {
  projectPath: string;
  title: string;
  language?: string;
  viewport: {
    width: number;
    height: number;
  };
  safeArea?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  themeCssPath?: string;
  slides: CompilerSlideInput[];
};

export type ExportOptions = {
  pdf?: boolean;
  html?: boolean;
  deckpkg?: boolean;
  thumbnails?: boolean;
};

export type ExportResult = {
  projectPath: string;
  exportsPath: string;
  artifacts: {
    pdf?: string;
    html?: string;
    deckpkg?: string;
    thumbnails?: string[];
    notes?: string;
  };
};

const DEFAULT_OPTIONS: Required<ExportOptions> = {
  pdf: true,
  html: true,
  deckpkg: true,
  thumbnails: true
};

const fileExistsText = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
};

const slugFileName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "deck";

const buildRenderableDeck = async (project: CompilerProjectInput): Promise<RenderDeck> => {
  const themeCss = project.themeCssPath
    ? await fileExistsText(path.resolve(project.projectPath, project.themeCssPath))
    : undefined;

  const slides = await Promise.all(
    project.slides.map(async (slide) => ({
      id: slide.id,
      title: slide.title,
      html: await readFile(path.resolve(project.projectPath, slide.sourcePath), "utf8"),
      notes: slide.notesPath ? await fileExistsText(path.resolve(project.projectPath, slide.notesPath)) : ""
    }))
  );

  return {
    title: project.title,
    language: project.language,
    viewport: project.viewport,
    safeArea: project.safeArea,
    themeCss,
    slides
  };
};

const writePdfSkeleton = async (project: CompilerProjectInput, outPath: string): Promise<void> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pageWidth = project.viewport.width * 0.75;
  const pageHeight = project.viewport.height * 0.75;

  for (const slide of project.slides) {
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawText(project.title, {
      x: 48,
      y: pageHeight - 64,
      size: 18,
      font,
      color: rgb(0.08, 0.09, 0.12)
    });
    page.drawText(`${slide.id} · ${slide.title}`, {
      x: 48,
      y: pageHeight - 104,
      size: 28,
      font,
      color: rgb(0.02, 0.08, 0.18),
      maxWidth: pageWidth - 96
    });
    page.drawText("HTMLslide alpha export skeleton", {
      x: 48,
      y: 48,
      size: 10,
      font,
      color: rgb(0.45, 0.48, 0.54)
    });
  }

  await writeFile(outPath, await pdf.save());
};

const blankPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAYAAAAEsCAIAAAD2HxkiAAAACXBIWXMAAAsTAAALEwEAmpwYAAABUklEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgZ1sAAQABQm1JAAAAAElFTkSuQmCC",
  "base64"
);

const writeThumbnails = async (project: CompilerProjectInput, exportsPath: string): Promise<string[]> => {
  const thumbnailsPath = path.join(exportsPath, "thumbnails");
  await mkdir(thumbnailsPath, { recursive: true });
  const paths: string[] = [];
  for (const slide of project.slides) {
    const outPath = path.join(thumbnailsPath, `${slide.id}.png`);
    await writeFile(outPath, blankPng);
    paths.push(outPath);
  }
  return paths;
};

const writeNotes = async (project: CompilerProjectInput, exportsPath: string): Promise<string> => {
  const notes = await Promise.all(
    project.slides.map(async (slide) => ({
      id: slide.id,
      title: slide.title,
      durationSec: slide.durationSec ?? 60,
      notes: slide.notesPath ? await fileExistsText(path.resolve(project.projectPath, slide.notesPath)) : ""
    }))
  );
  const outPath = path.join(exportsPath, "notes.json");
  await writeFile(outPath, `${JSON.stringify(notes, null, 2)}\n`);
  return outPath;
};

export const exportDeck = async (
  project: CompilerProjectInput,
  options: ExportOptions = DEFAULT_OPTIONS
): Promise<ExportResult> => {
  const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };
  const exportsPath = path.join(project.projectPath, "exports");
  await mkdir(exportsPath, { recursive: true });

  const baseName = slugFileName(project.title);
  const artifacts: ExportResult["artifacts"] = {};

  if (resolvedOptions.html) {
    const renderable = await buildRenderableDeck(project);
    const htmlPath = path.join(exportsPath, `${baseName}.html`);
    await writeFile(htmlPath, buildDeckHtml(renderable, "print"));
    artifacts.html = htmlPath;
  }

  if (resolvedOptions.pdf) {
    const pdfPath = path.join(exportsPath, `${baseName}.pdf`);
    await writePdfSkeleton(project, pdfPath);
    artifacts.pdf = pdfPath;
  }

  if (resolvedOptions.thumbnails) {
    artifacts.thumbnails = await writeThumbnails(project, exportsPath);
  }

  artifacts.notes = await writeNotes(project, exportsPath);

  if (resolvedOptions.deckpkg) {
    const zip = new JSZip();
    const manifest = {
      schemaVersion: "0.1.0",
      title: project.title,
      pdf: artifacts.pdf ? path.basename(artifacts.pdf) : null,
      slides: project.slides.map((slide, index) => ({
        id: slide.id,
        pdfPage: index + 1,
        thumbnail: `thumbnails/${slide.id}.png`,
        notes: slide.notesPath ?? null,
        durationSec: slide.durationSec ?? 60
      }))
    };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    if (artifacts.pdf) {
      zip.file("deck.pdf", await readFile(artifacts.pdf));
    }
    if (artifacts.notes) {
      zip.file("notes.json", await readFile(artifacts.notes));
    }
    for (const thumbnail of artifacts.thumbnails ?? []) {
      zip.file(`thumbnails/${path.basename(thumbnail)}`, await readFile(thumbnail));
    }
    zip.file("presenter-settings.json", JSON.stringify({ mode: "rehearsal", timer: true }, null, 2));
    const deckpkgPath = path.join(exportsPath, `${baseName}.deckpkg`);
    await writeFile(deckpkgPath, await zip.generateAsync({ type: "nodebuffer" }));
    artifacts.deckpkg = deckpkgPath;
  }

  return {
    projectPath: project.projectPath,
    exportsPath,
    artifacts
  };
};

