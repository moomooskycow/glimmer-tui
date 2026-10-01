import { mkdir, writeFile } from "node:fs/promises";
import { detectRenderMode, inTmux, termIndicatesFoot, wantsSixelProbe } from "./detect.js";
import { runHeadless } from "./headless.js";
import { parseSpec } from "./spec.js";
import { RendererSidecar } from "./sidecar.js";
import { normalizeCell } from "./pointer.js";
import { queryTerminal, runInteractive } from "./tui.js";
import { selectModel } from "./model.js";
import type { Theme } from "./types.js";

interface Args {
  command: string;
  render?: string;
  script: boolean;
  mock: boolean;
  theme?: Theme;
  delay: number;
  mouse: "cell" | "pixel";
  out: string;
  headless: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? "demo",
    script: false,
    mock: false,
    delay: 350,
    mouse: "cell",
    out: "artifacts/gallery",
    headless: false,
  };
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--script") args.script = true;
    else if (token === "--mock") args.mock = true;
    else if (token === "--headless") args.headless = true;
    else if (token === "--render" && next) {
      args.render = next;
      index += 1;
    } else if (token === "--theme" && (next === "light" || next === "dark")) {
      args.theme = next;
      index += 1;
    } else if (token === "--delay" && next) {
      args.delay = Number(next);
      index += 1;
    } else if (token === "--mouse" && (next === "cell" || next === "pixel")) {
      args.mouse = next;
      index += 1;
    } else if (token === "--out" && next) {
      args.out = next;
      index += 1;
    } else if (token === "--help" || token === "-h") {
      args.command = "help";
    }
  }
  return args;
}

const HELP = `glimmer

  npm run demo
  npm run demo -- --script --render text
  npm run gallery -- --out artifacts/gallery

Options
  --render auto|text|kitty|kitty-unicode|kitty-direct|sixel
  --script     drive the release demo without typing
  --mock       force the deterministic model
  --theme light|dark
  --mouse cell|pixel
  --delay ms   pause between scripted cards
  --headless   print the text transcript and exit
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (args.command === "gallery") {
    await gallery(args.out, args.theme);
    return;
  }
  const mock = args.mock || args.script || args.headless;
  const model = selectModel(mock);
  if (!process.stdout.isTTY || args.headless) {
    const result = await runHeadless({ script: true, model, theme: args.theme ?? "dark" });
    process.stdout.write(`${result.transcript}\n`);
    return;
  }
  const probed = await queryTerminal({ sixel: wantsSixelProbe(process.env, args.render) });
  const theme = args.theme ?? probed.theme ?? "dark";
  const cell = normalizeCell(probed.cellWidth, probed.cellHeight);
  const mode = detectRenderMode(process.env, args.render, probed.sixel);
  if (termIndicatesFoot() && args.mouse === "pixel") args.mouse = "cell";
  const renderer = mode === "text" ? null : await RendererSidecar.launch(theme, cell.dpr);
  await runInteractive({
    model,
    mode,
    theme,
    script: args.script,
    scriptDelay: args.delay,
    mouse: args.mouse,
    tmux: inTmux(),
    renderer,
    geometry: {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cellWidth: cell.cellWidth,
      cellHeight: cell.cellHeight,
      dpr: cell.dpr,
    },
  });
  process.exit(0);
}

async function gallery(outDir: string, only?: Theme): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const themes: Theme[] = only ? [only] : ["dark", "light"];
  const specs = gallerySpecs();
  for (const theme of themes) {
    const sidecar = await RendererSidecar.launch(theme, 2);
    try {
      for (const spec of specs) {
        const resolved = parseSpec(spec);
        const raster = await sidecar.open(resolved, {
          cols: 72,
          cellWidth: 20,
          cellHeight: 40,
          dpr: 2,
          maxRows: 36,
        });
        const file = `${outDir}/${theme}-${resolved.type}.png`;
        await writeFile(file, raster.png);
        process.stdout.write(`${file}  ${raster.cols}x${raster.rows} cells  ${raster.png.length} bytes\n`);
        await sidecar.close(resolved.id);
      }
    } finally {
      await sidecar.shutdown();
    }
  }
}

function gallerySpecs(): unknown[] {
  return [
    {
      type: "choice",
      title: "Which branch?",
      prompt: "I'll cut the release from this branch.",
      options: [
        { id: "release/2.4", label: "release/2.4", description: "Stable train, recommended" },
        { id: "main", label: "main", description: "Current trunk" },
        { id: "hotfix/auth", label: "hotfix/auth", description: "Auth regression only" },
      ],
    },
    {
      type: "form",
      title: "Release notes",
      prompt: "What should I put on the pull request?",
      submitLabel: "Continue",
      fields: [
        { name: "title", label: "PR title", placeholder: "Cut 2.4.0" },
        { name: "notes", label: "Notes", placeholder: "What landed?", multiline: true },
      ],
    },
    {
      type: "approval",
      title: "Open the release PR?",
      body: "Branch release/2.4. Cut the 2.4 release.",
      detail: "Cherry-pick the auth fix",
      approveLabel: "Approve",
      rejectLabel: "Reject",
    },
    {
      type: "table",
      title: "Commits on the train",
      selectable: true,
      columns: [
        { key: "sha", label: "SHA" },
        { key: "author", label: "Author" },
        { key: "subject", label: "Subject" },
      ],
      rows: [
        { sha: "a1c4e2", author: "mina", subject: "Fix session refresh" },
        { sha: "b90d11", author: "otto", subject: "Tighten auth cookie" },
        { sha: "c33aa8", author: "mina", subject: "Note the rollback" },
      ],
    },
    {
      type: "chart",
      title: "Risk by area",
      unit: "pts",
      series: [
        { label: "auth", value: 2 },
        { label: "api", value: 3 },
        { label: "billing", value: 5 },
      ],
    },
    {
      type: "diff",
      title: "release.ts",
      before: 'export const channel = "main";\nexport const notes = "";',
      after: 'export const channel = "release/2.4";\nexport const notes = "Cherry-pick the auth fix";',
    },
  ];
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
