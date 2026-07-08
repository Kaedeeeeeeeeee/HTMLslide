# HTMLslide 产品级开源开发计划

版本：0.1 草案  
日期：2026-07-08  
目标读者：开发 agent、核心开发者、设计协作者、测试负责人  
产品定位：免费开源、本地优先、AI-agent-first 的 HTML/PDF 幻灯片工程系统

---

## 0. 一句话定义

HTMLslide 是一个给 AI agent 制作幻灯片的桌面工作台：用户在 App 里下需求和审稿，agent 修改本地项目文件，HTMLslide 负责设计约束、检查、编译、导出和演讲。

核心公式：

```text
HTML / Markdown source
        ↓
HTMLslide spec + skills + compiler
        ↓
PDF / deckpkg / presenter artifact
```

产品原则：

```text
Install once. Use everywhere.

HTMLslide.app for humans.
htmlslide CLI for agents.
Same project. Same compiler. Same artifact.
```

---

## 1. 产品目标

### 1.1 要做什么

HTMLslide 要成为一个产品等级的开源桌面应用，而不是一个 demo、模板集合或 CLI 玩具。最终用户应该可以做到：

1. 下载一个 DMG，安装一个 HTMLslide.app。
2. 打开 App，选择 AI 使用方式。
3. 用自己的 API key，或者连接已有 Claude Code / Codex / Gemini CLI 等 coding agent。
4. 在 App 内输入自然语言需求，生成一套 HTML 源码幻灯片。
5. App 自动渲染、检查、修复、导出 PDF 和 presenter artifact。
6. 用户可以逐页审稿、局部修改、编辑 speaker notes。
7. 用户可以一键进入演讲者模式。
8. 高级用户和外部 agent 可以通过 CLI、MCP、skills 访问同一套能力。

### 1.2 不做什么

第一阶段不做这些：

1. 不做 HTMLslide 自己的 AI 订阅。
2. 不承担模型推理成本。
3. 不做完整 PowerPoint 式拖拽编辑器。
4. 不把 PPTX 当作源格式。
5. 不依赖用户必须安装 Claude Code / Codex。
6. 不把项目藏进私有数据库或不可读格式。
7. 不强制云同步。
8. 不把 Web App 作为主产品形态。

### 1.3 产品成功标准

产品达到可公开开源发布的标准时，必须满足：

```text
普通用户：
  下载 DMG → 打开 App → 填 API key 或连接已有 agent → 生成 deck → 导出 PDF → 演讲。

高级用户：
  用 htmlslide CLI / MCP / skills 在外部 Claude Code、Codex、Cursor、VS Code 中操作同一个项目。

开发者：
  可以在 monorepo 中清晰理解 core、desktop、cli、compiler、linter、agent、skills、presenter 的边界。

测试：
  有覆盖核心路径的自动化测试、golden deck fixtures、PDF/PNG 回归测试、Electron UI E2E、CLI E2E、打包测试。
```

---

## 2. 总体产品形态

### 2.1 对外产品

对用户只提供一个主产品：

```text
HTMLslide.app
```

macOS 分发方式：

```text
HTMLslide-<version>-arm64.dmg
HTMLslide-<version>-x64.dmg
HTMLslide-<version>-universal.dmg   可选
```

App 首次启动时安装和管理 CLI：

```bash
htmlslide
```

用户不会被要求单独安装 CLI。CLI 是 App 附带能力，不是另一个产品。

### 2.2 对内模块

内部采用 monorepo：

```text
htmlslide/
  apps/
    desktop/              # Electron App
    docs-web/             # 文档站，后期可加
  packages/
    core/                 # deck spec、project model、schema、filesystem
    cli/                  # htmlslide 命令行入口
    compiler/             # HTML → PDF/PNG/HTML/deckpkg
    linter/               # overflow、contrast、safe area、font、asset 检查
    renderer/             # slide runtime、preview runtime、print runtime
    presenter/            # 演讲者模式 runtime
    agent/                # BYOK agent orchestrator
    agent-adapters/       # Claude Code / Codex / Gemini CLI 等连接器
    mcp-server/           # HTMLslide MCP server
    skills/               # skill registry、installer、official skill pack
    design-system/        # App UI 设计系统
    shared-ui/            # React components
    test-fixtures/        # golden decks、mock projects、assets
    converters/           # PPTX/PDF/Markdown import/export，后置
  templates/
    default/
    swiss-editorial/
    consulting-clean/
    technical-dark/
    product-launch/
    data-report/
  scripts/
    build/
    release/
    notarize/
    test/
  docs/
    product/
    spec/
    dev/
    testing/
```

### 2.3 技术栈建议

```text
Desktop App:
  Electron + React + TypeScript + Vite

CLI:
  TypeScript / Node, packaged inside App bundle

Rendering / PDF:
  Electron Chromium first
  Optional Playwright renderer later if needed

State / storage:
  Local filesystem + JSON manifests
  SQLite only for App library index if needed; do not store project source in DB

MCP:
  TypeScript MCP server

AI orchestration:
  TypeScript provider interface
  OpenAI / Anthropic / compatible API adapters
  External agent adapters for Claude Code / Codex / Gemini CLI

Testing:
  Vitest for unit tests
  Playwright for Electron UI E2E
  pixelmatch / resemble-style visual diff for PNG regression
  jsonschema / zod for schema validation
```

---

## 3. 用户模式

HTMLslide 初始版本只提供三种 AI 模式。

### 3.1 模式 A：HTMLslide Agent with your API key

这是最原生体验。

```text
用户填写自己的 OpenAI / Anthropic / compatible API key。
HTMLslide 在 App 内完成生成、修改、检查、修复、导出。
模型费用由用户自己的 API key 账户承担。
HTMLslide 不做 AI 订阅，不承担模型成本。
```

用户体验：

```text
New Deck
→ 输入主题和要求
→ 上传资料或粘贴文本
→ 选择风格或 Auto
→ Generate
→ App 内生成 outline、视觉方向、全 deck
→ 自动 check / repair / export
```

### 3.2 模式 B：Connect a coding agent

用户已有 Claude Code / Codex / Gemini CLI 等工具时，可以把它们作为后台 worker。

```text
用户仍然在 HTMLslide App 内输入需求。
HTMLslide 在后台调用外部 coding agent。
外部 agent 修改项目文件。
HTMLslide 负责监听、渲染、检查、修复循环和导出。
```

用户不应该默认跳出到 terminal。

外部 agent 连接后，主流程仍然是：

```text
New Deck
→ AI Engine: Claude Code / Codex
→ Generate
→ HTMLslide App 显示生成进度、diff、QA、预览
```

### 3.3 模式 C：No AI

没有 API key，也没有外部 agent 时，HTMLslide 仍然可用：

```text
打开已有 deck 项目
预览 HTML slides
运行 check
导出 PDF
编辑 speaker notes
打开 presenter mode
安装和浏览 skills/templates
```

No AI 模式不能生成新内容，但不能让 App 变成废物。

---

## 4. 核心用户旅程

### 4.1 安装旅程

```text
1. 用户下载 HTMLslide.dmg。
2. 拖动 HTMLslide.app 到 Applications。
3. 打开 HTMLslide。
4. App 首次启动运行 setup wizard。
5. 用户选择默认工作区。
6. 用户选择 AI engine。
7. App 安装/更新 htmlslide CLI shim。
8. App 安装默认 official skills。
9. App 显示 Ready 页面。
```

Ready 页面示例：

```text
HTMLslide is ready.

✓ Desktop app installed
✓ Command line tool installed: htmlslide
✓ Default design skills installed
✓ Workspace: ~/Documents/HTMLslide

Try:
  htmlslide new my-talk
  htmlslide check
  htmlslide export
```

### 4.2 首次选择 AI engine

界面文案：

```text
Choose your AI engine

● HTMLslide Agent with your API key
  Native experience inside HTMLslide.
  You pay your model provider directly.

○ Connect a coding agent
  Use your existing Claude Code, Codex, Gemini CLI, or compatible coding agent.

○ Continue without AI
  Preview, check, export, and present existing decks.
```

### 4.3 新建 deck 旅程

```text
1. 用户点击 New Deck。
2. 输入 deck 名称。
3. 选择保存位置。
4. 输入自然语言 brief。
5. 添加资料：文件、网页文本、Markdown、CSV、图片。
6. 选择听众、时长、页数、语言、风格。
7. 选择 AI engine。
8. 点击 Generate。
```

New Deck 表单字段：

```text
Deck name: string
Location: default workspace / choose folder / existing git repo
Language: Auto / Chinese / English / Japanese / custom
Audience: executives / engineers / investors / students / general / custom
Duration: 5 / 10 / 20 / 30 / custom minutes
Slide count: Auto / exact number / range
Tone: concise / academic / executive / product-launch / technical / custom
Design direction: Auto / choose style / generate options first
Speaker notes: none / bullet notes / full script / rehearsal cues
Output: PDF / deckpkg / HTML / PNG thumbnails / optional PPTX later
```

### 4.4 视觉方向选择旅程

不要让 agent 一次性生成完整 deck。先生成视觉方向。

```text
1. Agent 生成 outline。
2. Agent 生成 3-6 个 visual direction。
3. 每个 direction 包含 2-3 张 sample slides：title、content、data/chart。
4. 用户选择一个方向。
5. Agent 用该方向生成完整 deck。
```

Visual Direction Card 包含：

```text
Preview thumbnails
Style name
Design rationale
Best for
Density level
Color mode
Typography feel
License / source skill
```

### 4.5 审稿和局部修改旅程

用户可以对整个 deck 或单页下命令：

```text
把整体变得更像技术产品发布会。
第 4 页文字太多，改成 2x2 matrix。
第 7 页图表不够有结论感，改成 insight-led chart。
第 10 页 speaker notes 写得太口语，改成更正式。
把所有标题改成更短、更有 punch。
```

App 将自然语言任务结构化：

```json
{
  "target": {
    "scope": "slide",
    "slideId": "004-market-map",
    "selection": null
  },
  "instruction": "Convert this slide into a 2x2 matrix with less text.",
  "constraints": [
    "Do not change slide id",
    "Keep 1920x1080 fixed viewport",
    "Run htmlslide check after edits",
    "Do not edit exports/"
  ]
}
```

### 4.6 导出和演讲旅程

```text
1. 用户点击 Export。
2. App 运行 check。
3. 如果有 error，提示修复或强制导出。
4. 生成 PDF、HTML、PNG thumbnails、notes.json、deckpkg。
5. 用户点击 Present。
6. App 检测外接显示器。
7. 外接屏显示 audience view。
8. 主屏显示 presenter console。
```

---

## 5. 文件管理设计

### 5.1 默认存储策略

采用 Obsidian / VS Code 式项目目录 + Apple 风格项目库。

默认工作区：

```text
~/Documents/HTMLslide/
```

首次启动允许用户选择：

```text
○ Documents / HTMLslide        推荐
○ iCloud Drive / HTMLslide     适合多台 Mac 同步，但可能有同步冲突
○ Choose Folder...             适合 Git repo / Dropbox / 外置盘
```

不建议默认 iCloud，因为 agent 会频繁修改多文件项目，可能引发同步冲突。

### 5.2 项目目录结构

一个 deck 项目是普通文件夹：

```text
my-talk/
  deck.json
  AGENTS.md
  CLAUDE.md
  README.md
  slides/
    001-title.html
    002-problem.html
    003-solution.html
  notes/
    001-title.md
    002-problem.md
    003-solution.md
  theme/
    theme.css
    tokens.json
    layout-rules.md
  assets/
    images/
    fonts/
    data/
  skills/
    project/
  .agents/
    skills/
      htmlslide/
        SKILL.md
  .claude/
    skills/
      htmlslide/
        SKILL.md
  .htmlslide/
    cache/
    checkpoints/
    logs/
    reports/
  exports/
    my-talk.pdf
    my-talk.deckpkg
    my-talk.html
    thumbnails/
```

### 5.3 App 项目库索引

App 维护最近项目索引，但不保存项目源内容：

```text
~/Library/Application Support/HTMLslide/library.json
```

示例：

```json
{
  "version": 1,
  "recentProjects": [
    {
      "id": "proj_abc123",
      "title": "HTML/PDF as New PPT",
      "path": "/Users/kaede/Documents/HTMLslide/html-pdf-new-ppt",
      "lastOpenedAt": "2026-07-08T10:00:00+09:00",
      "thumbnail": "/Users/kaede/Documents/HTMLslide/html-pdf-new-ppt/.htmlslide/cache/thumb.png"
    }
  ]
}
```

### 5.4 Source 和 Artifact 分离

源项目：

```text
slides/
notes/
theme/
assets/
deck.json
```

演讲和分享 artifact：

```text
exports/*.pdf
exports/*.deckpkg
exports/*.html
exports/thumbnails/
```

原则：

```text
Agent edits source.
HTMLslide compiles artifact.
Users present artifact.
```

---

## 6. Deck Spec

### 6.1 固定画布原则

幻灯片不是响应式网页。正式 slide 内容必须固定画布、整体缩放、不 reflow。

默认：

```json
{
  "viewport": {
    "width": 1920,
    "height": 1080
  },
  "aspectRatio": "16:9",
  "scalePolicy": "scale-only-no-reflow"
}
```

允许响应式的地方：

```text
App UI
Presenter UI
手机遥控 UI
Web gallery
文档站
```

不允许响应式 reflow 的地方：

```text
Audience slide content
PDF export source
正式演讲画面
```

### 6.2 deck.json 示例

```json
{
  "schemaVersion": "0.1.0",
  "id": "deck_html_pdf_new_ppt",
  "title": "HTML/PDF as the New PPT",
  "language": "zh-CN",
  "aspectRatio": "16:9",
  "viewport": {
    "width": 1920,
    "height": 1080
  },
  "safeArea": {
    "top": 72,
    "right": 96,
    "bottom": 72,
    "left": 96
  },
  "theme": {
    "css": "theme/theme.css",
    "tokens": "theme/tokens.json"
  },
  "slides": [
    {
      "id": "001-title",
      "title": "HTML as source, PDF as artifact",
      "source": "slides/001-title.html",
      "notes": "notes/001-title.md",
      "durationSec": 60,
      "kind": "title",
      "status": "draft"
    }
  ],
  "export": {
    "pdf": true,
    "html": true,
    "deckpkg": true,
    "thumbnails": true,
    "speakerNotes": true
  },
  "agent": {
    "preferredEngine": "htmlslide-byok",
    "lastRunId": null
  }
}
```

### 6.3 Slide source contract

每页 slide 是一个 HTML fragment，不是完整文档。

```html
<section class="slide title-slide" data-slide-id="001-title">
  <div class="eyebrow">Agent-native presentations</div>
  <h1>HTML as source, PDF as artifact</h1>
  <p class="subtitle">A new build pipeline for AI-generated decks</p>
</section>
```

规则：

```text
必须有 data-slide-id。
data-slide-id 必须与 deck.json 对应。
不得引用远程字体。
不得引用远程脚本。
不得写入 exports/。
不得使用 viewport-dependent media query 改变 slide layout。
允许使用 CSS variables 和 theme tokens。
```

### 6.4 Notes contract

每页 notes 是 Markdown：

```md
# 001-title

Opening line:
今天我想讨论一个看起来很小、但对 AI agent 时代非常重要的问题：PPT 是否还应该是默认的演示载体？

Key points:
- PPTX 对人类编辑器友好，但对 agent 不友好。
- HTML 适合生成和修改。
- PDF 适合稳定演讲和分发。

Timing: 60s
```

### 6.5 deckpkg 格式

`.deckpkg` 本质上是 zip 包，后缀自定义：

```text
my-talk.deckpkg
  manifest.json
  deck.pdf
  notes.json
  thumbnails/
    001-title.png
    002-problem.png
  presenter-settings.json
  assets/
```

manifest 示例：

```json
{
  "schemaVersion": "0.1.0",
  "title": "HTML/PDF as the New PPT",
  "pdf": "deck.pdf",
  "slides": [
    {
      "id": "001-title",
      "pdfPage": 1,
      "thumbnail": "thumbnails/001-title.png",
      "notes": "notes/001-title.md",
      "durationSec": 60
    }
  ]
}
```

---

## 7. CLI 设计

### 7.1 CLI 原则

CLI 是 App 附带接口，不是另一个产品。它必须：

```text
可被外部 agent 调用。
可被 CI 调用。
输出可机器解析的 JSON。
行为与 GUI 使用同一套 core。
不依赖 GUI 打开。
能在 App bundle 内运行 hidden mode。
```

### 7.2 命令列表

```bash
htmlslide new <name>
htmlslide init
htmlslide open [path]
htmlslide dev
htmlslide check
htmlslide check --json
htmlslide export
htmlslide export --pdf --html --deckpkg --thumbnails
htmlslide present [file]
htmlslide package
htmlslide skill list
htmlslide skill add <path-or-url>
htmlslide skill remove <name>
htmlslide skill inspect <name>
htmlslide agent engines
htmlslide agent test <engine>
htmlslide agent run --engine <engine> --task <task>
htmlslide repair --for claude|codex|generic
htmlslide mcp
htmlslide setup install-cli
htmlslide setup uninstall-cli
htmlslide doctor
```

### 7.3 Exit codes

```text
0  success
1  generic error
2  validation failed
3  export failed
4  missing dependency
5  permission denied
6  agent failed
7  project not found
8  incompatible schema
```

### 7.4 JSON output contract

所有重要命令支持 `--json`。

`htmlslide check --json` 输出：

```json
{
  "status": "failed",
  "projectPath": "/path/to/project",
  "summary": {
    "errors": 1,
    "warnings": 2,
    "info": 4
  },
  "issues": [
    {
      "slideId": "004-market-map",
      "severity": "error",
      "type": "text-overflow",
      "selector": ".body-copy",
      "message": "Text exceeds slide safe area by 38px at bottom.",
      "suggestedFix": "Shorten body copy or convert the paragraph into 3 bullets."
    }
  ]
}
```

### 7.5 CLI shim 安装

App 首次启动时安装一个 shim 到：

```text
/opt/homebrew/bin/htmlslide      Apple Silicon Homebrew 用户优先，如果存在且可写
/usr/local/bin/htmlslide         通用 fallback
~/.htmlslide/bin/htmlslide       用户本地 fallback
```

不要静默覆盖已有命令。

shim 行为：

```text
1. 读取 ~/.htmlslide/app-path.json。
2. 找到 HTMLslide.app。
3. 调用 App bundle 内的 CLI mode。
4. 如果找不到 App，提示用户打开 HTMLslide 修复。
```

`~/.htmlslide/app-path.json`：

```json
{
  "bundleId": "app.htmlslide.desktop",
  "appPath": "/Applications/HTMLslide.app",
  "version": "0.1.0",
  "updatedAt": "2026-07-08T10:00:00+09:00"
}
```

---

## 8. Electron Desktop App 设计

### 8.1 App 信息架构

```text
HTMLslide
  Welcome / Onboarding
  Project Library
  Project Workspace
    Slide Filmstrip
    Preview Canvas
    Inspector
      Outline
      Design
      Notes
      QA
      Export
    Agent Run Console
  AI Engines Settings
  Skills Library
  Templates Library
  Presenter Mode
  Developer Console
  Preferences
```

### 8.2 主要页面

#### 8.2.1 Welcome / Onboarding

目标：让用户完成基础配置。

步骤：

```text
1. Welcome
2. Choose workspace
3. Choose AI engine
4. Install CLI integration
5. Install official skills
6. Ready
```

每一步都必须可以 Skip。Skip 后 App 进入 No AI 模式。

#### 8.2.2 Project Library

布局：

```text
左侧：导航
  Recent
  Templates
  Skills
  AI Engines
  Settings

主区域：项目卡片
  thumbnail
  title
  path
  last opened
  status

顶部操作：
  New Deck
  Open Folder
  Open PDF/deckpkg
  Import
```

项目卡片状态：

```text
Ready
Needs check
Export failed
Missing files
External changes detected
```

#### 8.2.3 New Deck Wizard

采用分步骤，但不要太重。

```text
Step 1: Brief
Step 2: Sources
Step 3: Audience & output
Step 4: Design direction
Step 5: AI engine
Step 6: Generate
```

支持“快速模式”：一个大输入框 + Generate。

#### 8.2.4 Project Workspace

核心界面：

```text
┌──────────────────────────────────────────────────────────────┐
│ Toolbar: Generate | Check | Export | Present | Share          │
├──────────────┬───────────────────────────────┬───────────────┤
│ Filmstrip    │ Preview Canvas                │ Inspector     │
│              │                               │               │
│ 01 Title     │  rendered slide               │ Outline       │
│ 02 Problem   │                               │ Design        │
│ 03 Solution  │                               │ Notes         │
│ 04 Demo      │                               │ QA            │
│              │                               │ Export        │
├──────────────┴───────────────────────────────┴───────────────┤
│ Agent Run Console / Command Bar                               │
└──────────────────────────────────────────────────────────────┘
```

关键点：

```text
Preview 不是编辑器，而是审稿画布。
Filmstrip 支持选择 slide、查看 QA badge。
Inspector 支持编辑 notes、查看问题、选择 design tokens。
Command Bar 是自然语言修改入口。
```

#### 8.2.5 Agent Run Console

不要展示裸 terminal，展示结构化进度。

阶段：

```text
Plan
Outline
Visual direction
Build
Check
Repair
Export
Review
```

每个阶段展示：

```text
Status
Summary
Files changed
Issues found
Next action
Logs expandable
```

用户操作：

```text
Pause
Cancel
View diff
Accept changes
Revert
Retry
Open logs
Open terminal
```

#### 8.2.6 QA Panel

QA Panel 是产品护城河。

分类：

```text
Errors
Warnings
Suggestions
```

问题类型：

```text
text-overflow
safe-area-violation
low-contrast
font-missing
remote-asset
missing-asset
image-too-large
broken-link
missing-notes
title-too-long
body-too-dense
chart-label-too-small
slide-id-mismatch
export-outdated
```

每个 issue 显示：

```text
slide thumbnail
severity
message
selector / location
suggested fix
Fix with AI
Ignore once
Ignore rule
```

#### 8.2.7 Source View / Developer Console

这是高级功能，不是默认主流程。

包含：

```text
简单代码查看器
内置 terminal
logs
raw check report
MCP status
agent adapter status
```

不要试图复制完整 VS Code。

### 8.3 UI 视觉设计原则

HTMLslide 自己的 UI 应该克制、专业、类似开发工具与设计工具的结合。

关键词：

```text
Calm
Precise
Local-first
Developer-friendly
Presentation-focused
```

建议视觉方向：

```text
浅色为默认，深色可选。
左侧导航 + 中央 canvas + 右侧 inspector。
使用 neutral palette，减少彩色干扰。
QA error 使用明确但不过度刺眼的颜色。
Agent 状态使用步骤式 timeline。
```

关键 UI 状态必须清晰：

```text
Unsaved changes
Unexported changes
Export outdated
Agent running
Check failed
Ready to present
External files changed
```

### 8.4 无障碍要求

```text
所有主要操作可键盘访问。
QA issue 可被 screen reader 读取。
颜色不能作为唯一状态提示。
App UI contrast 达到 WCAG AA。
Presenter notes 字号可调。
演讲者模式支持高对比度。
```

---

## 9. AI Agent Orchestrator

### 9.1 Orchestrator 目标

HTMLslide 的 agent 不是自由聊天机器人，而是一个受控工作流。

状态机：

```text
idle
briefing
planning
visual_direction
awaiting_user_choice
building
checking
repairing
exporting
reviewing
failed
completed
cancelled
```

### 9.2 标准生成流程

```text
1. Normalize brief
2. Generate outline
3. Generate visual directions
4. Wait for user choice or auto-pick
5. Generate theme/tokens/layouts
6. Generate slides
7. Generate notes
8. Render deck
9. Run check
10. Repair loop, max 3 automatic rounds
11. Export artifacts
12. Present review summary
```

### 9.3 BYOK HTMLslide Agent

Provider interface：

```ts
interface ModelProvider {
  id: string;
  label: string;
  validateCredentials(): Promise<CredentialStatus>;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  estimateCost?(request: ModelRequest): Promise<CostEstimate>;
}
```

本地工具 interface：

```ts
interface HTMLslideTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  run(input: unknown, context: ToolContext): Promise<ToolResult>;
}
```

工具列表：

```text
read_project_file
write_project_file
list_project_files
list_slides
read_slide
write_slide
read_notes
write_notes
read_theme
write_theme
render_slide
render_deck
run_check
read_check_report
export_artifacts
create_checkpoint
show_diff
revert_checkpoint
```

安全限制：

```text
默认只能读写当前 deck project。
不能访问用户 home 其他目录。
不能运行任意 shell，除非用户显式允许。
API key 存 macOS Keychain。
发送给模型的上下文必须在 UI 中可解释。
```

### 9.4 Prompt 分层

```text
system prompt:
  HTMLslide product rules、fixed viewport、file boundaries、safety rules

skill prompt:
  当前选择的 design skill、layout rules、brand kit

deck context:
  deck.json、outline、slide list、QA report、user selection

task prompt:
  用户本次需求
```

### 9.5 Repair loop

```text
run check
if errors:
  summarize issues
  call agent with targeted repair prompt
  write edits
  run check again
max automatic repair rounds: 3
if still failing:
  show issues to user and suggest manual/AI fix
```

Repair prompt 必须包含：

```text
不要改 exports/
不要改 slide id
保持 1920x1080
优先压缩内容，其次改布局，最后降低字号
每次修复后运行 check
```

---

## 10. 外部 Coding Agent 集成

### 10.1 支持层级

每个外部 agent adapter 标注能力：

```text
detectInstalled
detectAuthenticated
headlessRun
streamLogs
installSkills
configureMCP
openExternal
cancelRun
readDiff
```

### 10.2 Claude Code Adapter

优先级：

```text
1. Claude Agent SDK integration
2. claude CLI headless/non-interactive invocation
3. MCP + skills
4. fallback: open external terminal with prepared prompt
```

连接向导：

```text
Detect Claude Code
Check auth
Install .claude/skills/htmlslide/SKILL.md
Configure HTMLslide MCP server if available
Run read-only test
```

### 10.3 Codex Adapter

优先级：

```text
1. codex exec / non-interactive mode
2. Codex MCP integration
3. .agents/skills/htmlslide/SKILL.md
4. fallback: open external terminal with prepared prompt
```

连接向导：

```text
Detect codex
Check auth or login status
Install .agents/skills/htmlslide/SKILL.md
Configure MCP
Run read-only test
```

### 10.4 Generic Agent Adapter

允许用户添加自定义命令：

```text
Command template:
  my-agent --cwd {{projectPath}} --prompt-file {{promptFile}}

Capabilities:
  edits files: yes/no
  supports streaming logs: yes/no
  supports cancellation: yes/no
```

### 10.5 外部 agent 运行 UX

即便使用 Claude Code / Codex，用户也留在 HTMLslide App 中。

App 显示：

```text
Claude Code is working on this deck.

✓ Created checkpoint
✓ Generated outline
• Editing slide source
• Running check
```

高级用户可展开 raw logs。

### 10.6 失败处理

失败类型：

```text
agent not installed
not authenticated
subscription/API unavailable
command failed
user denied permission
agent edited forbidden path
check still failing
run timed out
```

每种失败必须有可执行修复：

```text
Install guide
Login again
Switch AI engine
Use API key mode
Open Developer Console
Revert checkpoint
Copy repair prompt
```

---

## 11. MCP Server

### 11.1 目标

MCP 让外部 agent 以受控工具方式使用 HTMLslide，而不是猜 CLI 命令。

启动：

```bash
htmlslide mcp
```

### 11.2 Tools

```text
project_get_manifest
project_list_slides
slide_read
slide_write
notes_read
notes_write
theme_read
theme_write
render_slide
render_deck
check_deck
get_check_report
export_pdf
export_deckpkg
checkpoint_create
checkpoint_diff
checkpoint_revert
skill_list
skill_get_instructions
```

### 11.3 MCP 安全策略

```text
MCP server 默认只服务当前项目目录。
外部 agent 不能通过 MCP 读取项目外文件。
写操作必须记录 audit log。
危险操作需要 App 用户授权。
```

---

## 12. Skills 系统

### 12.1 Skill 原则

HTMLslide 不从零发明 skill 格式，兼容主流 Agent Skills 形态：

```text
skill-name/
  SKILL.md
  assets/
  references/
  scripts/
  templates/
```

HTMLslide 增加 deck-specific metadata。

### 12.2 DeckSkill metadata

在 `SKILL.md` frontmatter 中支持：

```yaml
---
name: swiss-editorial-deck
description: Create restrained editorial-style HTML/PDF slide decks.
license: MIT
deck:
  type: design-system
  output: html-slide
  viewport: 1920x1080
  preview:
    type: html
    entry: assets/preview.html
  supports:
    - fixed-viewport
    - speaker-notes
    - deck-check
  risk:
    scripts: false
    network: false
---
```

### 12.3 Official Skill Pack

首批官方 skills：

```text
deck-architect
  brief → outline → narrative structure

visual-direction
  generate 3-6 visual directions

swiss-editorial
  high-end editorial style

consulting-clean
  executive consulting style

technical-dark
  technical architecture / AI product style

product-launch
  product announcement / launch deck style

data-report
  charts, dashboards, metrics, business review

chart-redesign
  turn raw data into insight-led charts

speaker-notes
  notes, script, rehearsal cues

anti-ai-slop
  avoid generic AI-looking layouts and decorations

deck-repair
  fix overflow, contrast, density, font, asset issues

brand-kit
  convert brand docs into tokens and layout rules
```

### 12.4 Skill 安装位置

全局：

```text
~/.htmlslide/skills/
```

项目级：

```text
my-deck/skills/project/
my-deck/.agents/skills/htmlslide/
my-deck/.claude/skills/htmlslide/
```

### 12.5 Skill Library UI

每个 skill 卡片显示：

```text
Name
Description
Preview
Type
Author
License
Version
Last updated
Contains scripts?
Uses network?
Supports HTMLslide spec?
Install / Remove / Inspect
```

### 12.6 安全和许可证

第三方 skill 必须显示风险：

```text
MIT / Apache / BSD: safe to bundle if compatible
AGPL / GPL: do not bundle into official app without legal review
Unknown license: warn user
Contains scripts: require explicit permission
Contains remote assets: warn user
Requests network: warn user
```

Official Skill Pack 必须使用 MIT 或 Apache-2.0。

---

## 13. Compiler / Renderer / Exporter

### 13.1 渲染原则

```text
固定 viewport：1920x1080
固定 CSS page size
背景必须打印
字体必须可用或内嵌/打包
每页 slide 独立渲染
导出结果可重复
```

### 13.2 渲染模式

```text
preview mode:
  App canvas 实时预览单页或整套 deck。

check mode:
  渲染后读取 DOM geometry 和 computed styles。

export mode:
  生成 PDF、PNG、HTML、deckpkg。

present mode:
  读取 PDF/deckpkg，进入双屏演讲。
```

### 13.3 PDF 导出

优先使用 Electron/Chromium 的 PDF 能力。实现方式：

```text
1. 加载 print runtime HTML。
2. 每页 slide 映射到固定 CSS @page 尺寸。
3. 确保 printBackground。
4. 等待 fonts.ready、images loaded、layout stable。
5. 调用 printToPDF。
6. 生成 PDF。
7. 生成 thumbnails 和 notes sidecar。
```

### 13.4 PNG thumbnails

每页输出：

```text
.htmlslide/cache/thumbnails/<slide-id>.png
exports/thumbnails/<slide-id>.png
```

默认尺寸：

```text
384x216  small UI thumbnail
960x540  review thumbnail
1920x1080 optional full-size
```

### 13.5 HTML export

输出一个可独立打开的 HTML：

```text
exports/my-talk.html
```

要求：

```text
内联或相对引用所有 assets。
不能依赖 dev server。
支持键盘翻页。
可显示 speaker notes 但默认隐藏。
```

### 13.6 deckpkg export

生成：

```text
exports/my-talk.deckpkg
```

必须包含：

```text
manifest.json
deck.pdf
notes.json
thumbnails/
presenter-settings.json
```

---

## 14. Linter / QA Checker

### 14.1 检查等级

```text
error:
  会导致导出或演讲明显失败。

warning:
  不阻塞导出，但影响质量。

suggestion:
  设计建议，不阻塞。
```

### 14.2 检查项目

#### 结构检查

```text
deck.json schema valid
slide source exists
notes source exists if required
slide id matches data-slide-id
no duplicate slide id
exports not modified as source
```

#### 布局检查

```text
text overflow
safe area violation
element outside viewport
body too dense
title too long
font size too small
chart label too small
```

#### 视觉检查

```text
low contrast
too many font families
too many colors
image pixelated
image too large
unbalanced whitespace, suggestion only
```

#### 资源检查

```text
missing asset
remote image
remote font
broken link
large asset
unsupported media
```

#### Notes 检查

```text
missing notes
notes too short
notes too long for duration
slide duration missing
```

#### Export 检查

```text
PDF outdated
thumbnails outdated
manifest mismatch
pdf page count mismatch
```

### 14.3 DOM geometry 检查

每页渲染后注入检查脚本：

```ts
const slideRect = slide.getBoundingClientRect();
const safeArea = getSafeArea(deck);
for (const el of elements) {
  const rect = el.getBoundingClientRect();
  if (rect.bottom > safeArea.bottom) report(...);
}
```

### 14.4 可机器修复报告

每个 issue 必须包含：

```text
slideId
severity
type
selector
message
measurement
suggestedFix
agentInstruction
```

示例：

```json
{
  "slideId": "005-growth",
  "severity": "error",
  "type": "safe-area-violation",
  "selector": ".chart-caption",
  "measurement": {
    "overflowBottomPx": 24
  },
  "message": "Caption exceeds bottom safe area by 24px.",
  "suggestedFix": "Shorten caption or move it above the chart.",
  "agentInstruction": "Fix slide 005-growth. Keep layout fixed at 1920x1080. Prefer shortening the caption before reducing font size."
}
```

---

## 15. Presenter Mode

### 15.1 目标

支持正式演讲场景：

```text
外接大屏：观众画面
自己小屏：当前页、下一页、notes、timer、进度、跳页
```

### 15.2 Presenter Console

显示：

```text
Current slide preview
Next slide preview
Speaker notes
Timer
Elapsed / remaining time
Progress bar
Slide number
Search / jump to slide
Black screen toggle
Pause timer
Font size control for notes
```

### 15.3 Audience View

显示：

```text
PDF page or rendered slide
Full screen
No UI chrome
Keyboard / remote controlled
```

### 15.4 多屏策略

```text
如果检测到外接显示器：
  默认外接屏 Audience View，主屏 Presenter Console。

如果只有一个屏幕：
  提供 Windowed Presenter / Rehearsal Mode。

用户可手动交换屏幕。
```

### 15.5 演讲控制

快捷键：

```text
→ / Space: next
←: previous
B: black screen
W: white screen
F: fullscreen
G: jump to slide
T: pause/resume timer
+/-: notes font size
Esc: exit presenter mode
```

### 15.6 手机遥控，后置

后续可添加：

```text
local websocket
QR code pairing
phone next/prev/timer
```

---

## 16. 安装、打包和发布

### 16.1 macOS DMG

第一阶段只要求 macOS。Windows/Linux 后置。

打包产物：

```text
HTMLslide-<version>-arm64.dmg
HTMLslide-<version>-x64.dmg
```

要求：

```text
App signed
DMG signed if needed
Notarized
Stapled
CLI/helper binaries signed
```

### 16.2 CLI provisioning

首次启动时：

```text
检测已有 htmlslide 命令
检测是否指向当前 App
安装或更新 shim
不覆盖用户已有无关命令
提供 uninstall
```

Preferences 页面必须包含：

```text
CLI Integration
  Status
  Path
  Version
  Reinstall
  Uninstall
  Copy manual install command
```

### 16.3 自动更新

开源初期可以先不做自动更新，但 release 后建议加入：

```text
Check for Updates
GitHub Releases feed
下载 DMG 或 zip
显示 release notes
```

不要在未签名/未 notarized 阶段开启自动更新。

---

## 17. 隐私和安全

### 17.1 本地优先

默认：

```text
项目文件保存在本地。
HTMLslide 不上传项目到自己的服务器。
没有 HTMLslide 账号。
没有 HTMLslide 云同步。
```

### 17.2 API key

```text
存 macOS Keychain。
不写入项目目录。
不写入 logs。
不提交到 Git。
UI 中支持删除和测试。
```

### 17.3 模型调用透明度

每次调用模型前，用户应知道：

```text
使用哪个 provider
使用哪个 model
会发送哪些项目上下文
估计 token 或成本，如果 provider 支持
```

### 17.4 外部 agent 权限

外部 coding agent run 前：

```text
创建 checkpoint
限制工作目录
显示将允许的操作
记录 changed files
run 后展示 diff
用户可接受或回滚
```

默认禁止：

```text
修改项目外文件
修改 exports/ 作为源文件
读取 Keychain
读取其他项目
```

### 17.5 Logs

logs 存放：

```text
my-deck/.htmlslide/logs/
```

必须支持：

```text
redact API keys
redact bearer tokens
用户一键清理 logs
```

---

## 18. Git / Checkpoint / Diff

### 18.1 自动 checkpoint

每次 agent run 前自动创建 checkpoint。

实现策略：

```text
如果项目是 git repo：
  使用 git worktree/status/diff，不自动 commit，创建 internal patch snapshot。

如果项目不是 git repo：
  复制 changed source files 到 .htmlslide/checkpoints/<run-id>/。
```

### 18.2 Review changes UI

Agent run 结束后显示：

```text
Files changed
Slides changed
Before/after thumbnails
Text diff
CSS diff
QA delta
Accept changes
Revert changes
```

### 18.3 回滚要求

```text
必须能回滚 slides/
notes/
theme/
assets/
deck.json
不得误删用户新加资料
```

---

## 19. 测试计划

测试必须从第一天设计，不要等 UI 完成后补。

### 19.1 测试分层

```text
Unit tests
Schema tests
CLI tests
Compiler tests
Linter tests
Agent orchestrator tests
External agent adapter tests
MCP tests
Desktop UI tests
Presenter tests
Packaging tests
Security tests
Performance tests
Regression fixtures
```

### 19.2 Unit tests

覆盖：

```text
path resolver
project loader
manifest parser
schema validator
slide id validator
safe area calculation
issue severity aggregator
export manifest builder
skill metadata parser
```

要求：

```text
core package coverage >= 85%
linter package coverage >= 80%
agent tool wrappers coverage >= 80%
```

### 19.3 Schema tests

Fixtures：

```text
valid minimal deck
valid full deck
missing slide source
duplicate slide id
invalid viewport
invalid safe area
unsupported schema version
```

每个 fixture 预期明确。

### 19.4 CLI E2E tests

测试命令：

```bash
htmlslide new test-deck
htmlslide check --json
htmlslide export --pdf --deckpkg
htmlslide package
htmlslide doctor
```

要求：

```text
exit code 正确
stdout/stderr 正确
--json 可 parse
失败时有 actionable error
```

### 19.5 Compiler tests

Golden deck fixtures：

```text
minimal-deck
text-heavy-deck
data-chart-deck
image-heavy-deck
notes-deck
multi-theme-deck
```

检查：

```text
PDF exists
PDF page count matches slide count
thumbnails generated
manifest page mapping correct
fonts loaded
export deterministic enough for regression
```

### 19.6 Visual regression tests

对 golden deck 输出 PNG，并做像素差异比较。

阈值：

```text
small thumbnails: <= 0.5% diff
full slide screenshots: <= 0.2% diff
```

发生 diff 时在 CI artifact 中上传：

```text
before.png
after.png
diff.png
```

### 19.7 Linter tests

为每个 issue 类型建 fixture。

```text
text-overflow fixture must fail
safe-area fixture must fail
contrast fixture must warn
remote-font fixture must warn/error
missing-notes fixture must warn
valid-clean fixture must pass
```

### 19.8 Agent orchestrator tests

使用 mock model provider，不调用真实 API。

测试：

```text
brief → outline
outline → visual directions
full build flow
repair loop stops after success
repair loop stops after max rounds
provider error recovery
cancel run
checkpoint created
```

### 19.9 External agent adapter tests

使用 fake commands：

```text
fake-claude
fake-codex
fake-agent
```

模拟：

```text
not installed
not authenticated
successful edit
command failure
long-running stream
cancelled run
forbidden file edit
```

不要在 CI 中依赖真实 Claude Code / Codex 登录。

### 19.10 MCP tests

测试：

```text
server starts
tools listed
read-only tools work
write tools respect project boundary
check_deck returns schema-valid report
export_pdf creates artifact
invalid path denied
```

### 19.11 Electron UI E2E

使用 Playwright for Electron 或等价方案。

核心路径：

```text
first launch onboarding
choose workspace
add fake API key provider
create new deck with mock agent
render preview
run check
export PDF
open presenter rehearsal mode
open settings and reinstall CLI shim
```

### 19.12 Presenter tests

自动化：

```text
open deckpkg
load notes
next/prev navigation
timer starts/stops
single-screen rehearsal mode
keyboard shortcuts
```

人工测试：

```text
MacBook + external monitor
AirPlay / HDMI / USB-C monitor
Presenter screen swap
Full-screen behavior
Display disconnect/reconnect
```

### 19.13 Packaging tests

CI 产出 unsigned build；release 产出 signed/notarized build。

测试：

```text
DMG mounts
App launches from /Applications
first-run setup works
CLI shim installed
htmlslide doctor passes
App can be moved and CLI repairs after launch
uninstall CLI works
```

### 19.14 Security tests

```text
API key not in logs
API key not in project files
external agent cannot write outside project in protected mode
MCP path traversal blocked
third-party skill with scripts requires warning
remote assets detected
malformed deckpkg rejected
```

### 19.15 Performance tests

目标：

```text
Open 20-slide project: < 2s to show library preview after warm start
Render single slide preview: < 500ms after file change for typical slide
Export 20-slide PDF: < 15s on modern MacBook, excluding AI time
Check 20-slide deck: < 10s
Presenter next slide latency: < 100ms
```

实际阈值可在 alpha 阶段根据基准调整。

### 19.16 手工验收剧本

每个 release candidate 必须跑一次：

```text
1. Clean macOS user account.
2. Install DMG.
3. First launch setup.
4. Create deck using mock/local provider.
5. Create deck using BYOK provider if key available.
6. Connect fake external agent.
7. Export PDF/deckpkg.
8. Present on external monitor.
9. Reopen project.
10. Revert an agent run.
11. Uninstall CLI.
12. Delete App and ensure no unexpected system files remain.
```

---

## 20. CI/CD

### 20.1 GitHub Actions jobs

```text
lint
  pnpm lint
  pnpm typecheck

unit
  pnpm test

schema
  deck schema fixtures

cli-e2e
  build CLI and run fixture commands

compiler-regression
  export golden decks and compare PNG/PDF metadata

electron-e2e
  run Electron UI tests on macOS

package-macos
  build DMG unsigned for PR / signed for release

security
  secret scanning, dependency audit, path traversal tests
```

### 20.2 Release flow

```text
1. Merge to main.
2. Nightly build unsigned artifacts.
3. Tag vX.Y.Z.
4. Release workflow builds signed/notarized DMG.
5. Attach artifacts to GitHub Releases.
6. Generate changelog.
7. Publish docs.
```

### 20.3 Versioning

Use semantic versioning:

```text
0.x: breaking changes allowed with migration notes
1.0: stable project format and CLI contract
```

Deck schema version independent from App version：

```text
schemaVersion: 0.1.0
appVersion: 0.1.0
```

---

## 21. 开发阶段计划

### Phase 0：Specification & Design Foundation

目标：把核心边界定死。

交付物：

```text
deck.json schema v0.1
project folder spec
CLI command spec
UI wireframes
Agent run state machine
official skill metadata spec
testing fixture plan
```

验收：

```text
开发 agent 可以根据 spec 创建一个合法项目。
schema tests 可以跑。
UI wireframe 覆盖核心用户旅程。
```

### Phase 1：Core + CLI + Local Project

目标：没有 GUI 也能创建、检查、导出最小 deck。

任务：

```text
packages/core
packages/cli
project loader
schema validator
htmlslide new/init/check/export skeleton
default template
basic HTML runtime
```

验收：

```bash
htmlslide new demo
cd demo
htmlslide check --json
htmlslide export --pdf --deckpkg
```

必须通过。

### Phase 2：Compiler + Linter

目标：形成 HTML → PDF → QA 的可靠闭环。

任务：

```text
fixed viewport renderer
PDF export
PNG thumbnails
safe area checker
text overflow checker
asset checker
font checker
notes checker
report.json
visual regression fixtures
```

验收：

```text
golden decks 可导出。
故意错误 fixtures 会被检测出来。
report.json 可被 agent 使用。
```

### Phase 3：Electron App Skeleton

目标：用户可通过 App 打开和预览项目。

任务：

```text
onboarding
project library
workspace layout
filmstrip
preview canvas
inspector tabs
QA panel
export button
settings
CLI integration page
```

验收：

```text
用户能通过 App 新建项目、查看 slides、运行 check、导出 PDF。
CLI shim 可安装和卸载。
```

### Phase 4：BYOK HTMLslide Agent

目标：用用户 API key 在 App 内生成 deck。

任务：

```text
API key storage in Keychain
provider interface
OpenAI adapter
Anthropic adapter
mock provider
agent orchestrator
brief → outline → visual direction → build → check → repair → export
Agent Run Console
checkpoint/diff/revert
```

验收：

```text
用 mock provider 完整生成 deck。
用真实 provider 在人工测试中生成 8-12 页 deck。
失败时可回滚。
```

### Phase 5：External Agent Adapters

目标：连接用户已有 Claude Code / Codex。

任务：

```text
Claude Code detector
Codex detector
connection wizard
skill installer
MCP config
headless run adapter
fake adapter tests
logs streaming
fallback external terminal
```

验收：

```text
未安装时提示明确。
安装但未登录时提示明确。
fake adapter 可以跑完整 agent run。
真实 Claude/Codex 作为人工测试通过。
```

### Phase 6：Presenter Mode

目标：产品可正式演讲。

任务：

```text
deckpkg reader
single-screen rehearsal mode
dual-screen presenter mode
speaker notes UI
timer
current/next preview
keyboard shortcuts
screen selection
```

验收：

```text
MacBook + 外接屏测试通过。
deckpkg 双击打开。
PDF + notes 对齐正确。
```

### Phase 7：Packaging & Public Alpha

目标：发布可下载 DMG。

任务：

```text
electron-builder config
macOS signing
notarization
DMG layout
GitHub Releases
release notes
install docs
contribution docs
security policy
license
```

验收：

```text
干净 macOS 环境可安装。
Gatekeeper 不报未知开发者阻断。
首次启动设置成功。
核心 demo 跑通。
```

### Phase 8：Product Hardening

目标：从 alpha 进入 beta。

任务：

```text
error handling polish
performance optimization
visual regression expansion
skill library UI
more official skills
docs examples
issue templates
telemetry optional design, if any
accessibility improvements
```

验收：

```text
真实用户可以从 0 到演讲完成一套 deck。
bug 报告可定位。
开发者可以贡献 skill/template。
```

---

## 22. Definition of Done

任何功能完成必须满足：

```text
1. 有用户可见路径或明确内部 API。
2. 有 TypeScript 类型。
3. 有错误处理。
4. 有测试。
5. 有文档或开发说明。
6. 不破坏 golden fixtures。
7. 不引入未声明外部网络访问。
8. 不把用户 API key 写入 logs。
9. CLI 和 GUI 行为一致。
10. 如果影响 agent，需要更新 AGENTS.md / SKILL.md。
```

---

## 23. 给开发 agent 的执行规则

开发 agent 在仓库中工作时必须遵守：

```text
1. 先读 AGENTS.md。
2. 不直接编辑 exports/。
3. 不破坏 deck.json schema。
4. 不把 API key 或 token 写入代码、fixtures、logs。
5. 修改核心行为时同步更新测试。
6. 修改 CLI 输出时同步更新 CLI E2E tests。
7. 修改 renderer 时同步更新 visual regression fixtures。
8. 修改 skill spec 时同步更新 docs/spec/skills.md。
9. 每次任务结束运行 pnpm lint、pnpm test 或相关 subset。
10. 输出变更摘要、测试结果、未完成事项。
```

示例 AGENTS.md：

```md
# HTMLslide Development Rules

This repository builds HTMLslide, a local-first presentation studio for AI-generated HTML/PDF decks.

Before editing:
- Read docs/spec/deck.md.
- Read docs/spec/cli.md.
- Read docs/spec/skills.md.

Rules:
- Do not commit secrets.
- Do not modify generated exports unless a test explicitly requires it.
- Keep GUI and CLI behavior backed by shared core packages.
- Add tests for every behavior change.
- Prefer deterministic fixtures.
- Run the narrowest relevant test first, then full test if practical.
```

---

## 24. 关键风险和缓解

### 风险 1：Electron App 太重

缓解：

```text
接受 v1 重量，因为产品需要 Chromium、多窗口、本地文件、PDF。
优化启动速度和 lazy loading。
后续可探索 Tauri/Swift Presenter，但不作为 v1 主线。
```

### 风险 2：外部 agent UX 割裂

缓解：

```text
默认在 App 内调度外部 agent。
只把 terminal 作为高级功能。
用 connection wizard 和 Agent Run Console 包装复杂性。
```

### 风险 3：BYOK 用户不知道模型费用

缓解：

```text
明确文案：You pay your provider directly。
显示 provider/model。
支持 cost estimate if available。
支持 usage log。
```

### 风险 4：agent 乱改文件

缓解：

```text
项目目录隔离。
每次 run 前 checkpoint。
run 后 diff review。
MCP 工具限制路径。
禁止默认访问项目外文件。
```

### 风险 5：HTML 渲染和 PDF 不一致

缓解：

```text
固定 Chromium renderer。
固定 viewport。
使用 print runtime。
visual regression。
不要让正式 slide 响应式 reflow。
```

### 风险 6：Skill 许可证污染

缓解：

```text
official skill pack 使用 MIT/Apache-2.0。
第三方 skill 不默认 bundle。
Skill UI 显示 license 和风险。
AGPL/GPL skill 需要用户主动安装。
```

### 风险 7：产品变成另一个 PPT 编辑器

缓解：

```text
不做完整 canvas drag editor。
App 重点是 brief、review、QA、export、presenter。
源码由 agent 修改。
人负责审稿和意图。
```

---

## 25. 首批官方模板建议

### 25.1 default

适合一般用途，简单稳定。

### 25.2 swiss-editorial

```text
大字号标题
强网格
少颜色
高留白
适合思想型演讲和产品叙事
```

### 25.3 consulting-clean

```text
结论型标题
矩阵、流程、对比、框架
适合商业汇报
```

### 25.4 technical-dark

```text
深色背景
代码、架构图、系统流程
适合开发者和 AI 工具演示
```

### 25.5 product-launch

```text
产品截图
hero visual
feature blocks
roadmap
适合发布会和 startup pitch
```

### 25.6 data-report

```text
图表、指标卡、趋势、dashboard
强调 insight-led charts
```

---

## 26. 文档站结构

```text
docs/
  index.md
  getting-started.md
  install.md
  create-your-first-deck.md
  ai-engines.md
  byok.md
  connect-claude-code.md
  connect-codex.md
  project-structure.md
  cli.md
  mcp.md
  skills.md
  design-skills.md
  presenter-mode.md
  exporting.md
  troubleshooting.md
  contributing.md
  testing.md
  release.md
  security.md
```

文档必须包含：

```text
快速开始
无 AI 模式
BYOK 模式
外部 agent 模式
项目格式
CLI reference
开发 agent 贡献指南
skill 贡献指南
测试指南
```

---

## 27. 开源治理

建议：

```text
License: Apache-2.0 或 MIT
Code of Conduct: Contributor Covenant
Security policy: SECURITY.md
Contributing: CONTRIBUTING.md
Issue templates:
  bug report
  feature request
  skill contribution
  deck rendering bug
  external agent integration bug
PR template:
  summary
  screenshots
  tests
  breaking changes
```

官方 repo 不内置许可证不兼容的第三方 skill。可以维护一个 registry 索引，但安装由用户主动触发。

---

## 28. 最小公开 Alpha 验收清单

Alpha 版本必须能做到：

```text
安装：
  [ ] DMG 可安装
  [ ] App 可启动
  [ ] CLI shim 可安装
  [ ] htmlslide doctor 通过

项目：
  [ ] New Deck 创建项目
  [ ] Open Folder 打开项目
  [ ] Project Library 显示最近项目

生成：
  [ ] Local Mock provider 完整流程通过
  [ ] BYOK provider-backed sourceWrites/check/export 流程通过
  [ ] 至少一个真实 provider 人工验证通过
  [ ] 生成 outline
  [ ] 生成 visual directions
  [ ] 生成 full deck

检查：
  [ ] check 可发现 overflow
  [ ] check 可发现 missing asset
  [ ] check 可发现 missing notes
  [ ] QA panel 显示问题

导出：
  [ ] PDF page count 正确
  [ ] PNG thumbnails 正确
  [ ] deckpkg 可打开

演讲：
  [ ] Rehearsal mode 可用
  [ ] Dual-screen presenter 人工测试通过

外部 agent：
  [ ] fake adapter 自动化通过
  [ ] Claude/Codex 至少一种真实连接人工通过

测试：
  [ ] unit tests pass
  [ ] CLI E2E pass
  [ ] compiler regression pass
  [ ] Electron E2E pass
  [ ] packaging smoke test pass
```

---

## 29. 推荐第一批开发任务拆分

可以把任务分给多个开发 agent：

### Agent A：Spec + Core

```text
创建 deck.json schema
实现 project loader
实现 path resolver
实现 manifest validator
写 schema fixtures
```

### Agent B：CLI

```text
实现 htmlslide new/init/check/export skeleton
实现 --json 输出
实现 exit codes
实现 doctor
```

### Agent C：Renderer/Compiler

```text
实现 fixed viewport runtime
实现 HTML preview document builder
实现 PDF export
实现 PNG thumbnails
实现 deckpkg writer
```

### Agent D：Linter

```text
实现 safe area / overflow / asset / notes 检查
实现 report.json
实现 fixtures
```

### Agent E：Electron App

```text
实现 onboarding
project library
workspace layout
preview canvas
QA panel
export button
settings
```

### Agent F：Agent Orchestrator

```text
实现 mock provider
BYOK provider interface
state machine
checkpoint
repair loop
Agent Run Console integration
```

### Agent G：External Agent Integration

```text
实现 fake adapter
Claude/Codex detector skeleton
skill installer
MCP server skeleton
connection wizard UI
```

### Agent H：Testing/Release

```text
搭建 CI
visual regression
electron e2e
packaging smoke test
release scripts
notarization docs
```

---

## 30. 参考资料

这些是开发过程中应参考的官方资料或规范入口，实际实现时必须以最新官方文档为准。

```text
Electron docs
https://www.electronjs.org/docs/latest/

Electron webContents.printToPDF
https://www.electronjs.org/docs/latest/api/web-contents

Electron screen API
https://www.electronjs.org/docs/latest/api/screen

Electron process.resourcesPath
https://www.electronjs.org/docs/latest/api/process

Electron code signing
https://www.electronjs.org/docs/latest/tutorial/code-signing

electron-builder DMG
https://www.electron.build/docs/dmg/

electron-builder macOS config
https://www.electron.build/docs/mac/

Apple Developer ID
https://developer.apple.com/developer-id/

Apple notarization
https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution

OpenAI Codex CLI
https://developers.openai.com/codex/cli/

OpenAI Codex skills
https://developers.openai.com/codex/skills

OpenAI Codex MCP
https://developers.openai.com/codex/mcp

Anthropic Claude Code overview
https://docs.anthropic.com/en/docs/claude-code/overview

Claude Agent SDK
https://code.claude.com/docs/en/agent-sdk/overview

Claude Agent Skills
https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

Claude Code MCP
https://docs.anthropic.com/en/docs/claude-code/mcp
```

---

## 31. 最终产品判断

HTMLslide 的核心不是“用 HTML 做 PPT”，而是：

```text
把幻灯片制作变成 agent 可执行、机器可检查、稳定可导出的工程流程。
```

因此，产品等级的关键不是做一个漂亮的 canvas editor，而是把下面这些闭环打磨到可靠：

```text
用户 brief
→ agent 计划
→ visual direction
→ source edits
→ render
→ check
→ repair
→ export
→ present
→ review / revert
```

只要这个闭环稳定，HTMLslide 就会明显区别于传统 PPT、普通 HTML slide framework、以及零散的 AI slide skill。
