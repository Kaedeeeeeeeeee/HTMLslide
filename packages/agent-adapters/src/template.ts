import {
  inferPathVariableNames,
  validateTemplatePathVariables
} from "./boundary.js";
import { AgentAdapterFailureError, createAgentAdapterFailure } from "./failures.js";
import type { RenderedCommand } from "./types.js";

const PLACEHOLDER_PATTERN = /{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g;

export interface RenderCommandTemplateOptions {
  readonly projectRoot: string;
  readonly variables: Readonly<Record<string, string | undefined>>;
  readonly pathVariables?: readonly string[];
}

export function renderCommandTemplate(template: string, options: RenderCommandTemplateOptions): RenderedCommand {
  const pathVariables = options.pathVariables ?? inferPathVariableNames(options.variables);
  validateTemplatePathVariables(options.projectRoot, options.variables, pathVariables);

  const tokenTemplates = tokenizeCommandTemplate(template);
  const tokens = tokenTemplates.map((token) => renderTemplateToken(token, options.variables));
  const command = tokens[0];

  if (command === undefined || command.length === 0) {
    throw new AgentAdapterFailureError(
      createAgentAdapterFailure("template-render-error", {
        detail: "Command template must render at least one command token."
      })
    );
  }

  return {
    command,
    args: tokens.slice(1)
  };
}

export function tokenizeCommandTemplate(template: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | "\"" | undefined;

  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    if (char === undefined) {
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      } else {
        token += char;
      }
      tokenStarted = true;
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") {
        quote = undefined;
      } else if (char === "\\" && index + 1 < template.length) {
        index += 1;
        token += template[index] ?? "";
      } else {
        token += char;
      }
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }

    if (char === "\\" && index + 1 < template.length) {
      index += 1;
      token += template[index] ?? "";
      tokenStarted = true;
      continue;
    }

    token += char;
    tokenStarted = true;
  }

  if (quote !== undefined) {
    throw new AgentAdapterFailureError(
      createAgentAdapterFailure("template-render-error", {
        detail: "Command template contains an unterminated quote."
      })
    );
  }

  if (tokenStarted) {
    tokens.push(token);
  }

  return tokens;
}

function renderTemplateToken(token: string, variables: Readonly<Record<string, string | undefined>>): string {
  return token.replace(PLACEHOLDER_PATTERN, (_placeholder, variableName: string) => {
    const value = variables[variableName];

    if (value === undefined) {
      throw new AgentAdapterFailureError(
        createAgentAdapterFailure("template-render-error", {
          detail: `Missing command template variable: ${variableName}.`
        })
      );
    }

    return value;
  });
}
