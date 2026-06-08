import fs from "node:fs";
import path from "node:path";

const ACTION_TYPES = new Set(["navigate", "click", "fill", "wait", "none"]);

export function loadDemoScript(filePath) {
  const absolutePath = path.resolve(filePath);
  const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  validateDemoScript(parsed, absolutePath);
  return parsed;
}

export function loadProductKnowledge(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

export function validateDemoScript(script, source = "demo script") {
  if (!script || typeof script !== "object") {
    throw new Error(`${source} must be a JSON object.`);
  }

  if (!Array.isArray(script.steps) || script.steps.length === 0) {
    throw new Error(`${source} must contain at least one step.`);
  }

  for (const [index, step] of script.steps.entries()) {
    if (!step.id || !step.title || !step.say) {
      throw new Error(`${source} step ${index + 1} requires id, title, and say.`);
    }

    if (step.action) {
      if (!ACTION_TYPES.has(step.action.type)) {
        throw new Error(
          `${source} step ${step.id} has unsupported action type "${step.action.type}".`
        );
      }

      if (step.action.type === "navigate" && !step.action.url) {
        throw new Error(`${source} step ${step.id} navigate action requires url.`);
      }

      if ((step.action.type === "click" || step.action.type === "fill") && !step.action.selector) {
        throw new Error(`${source} step ${step.id} ${step.action.type} action requires selector.`);
      }

      if (step.action.type === "fill" && step.action.value == null) {
        throw new Error(`${source} step ${step.id} fill action requires value.`);
      }
    }
  }
}

export function findStepForQuestion(script, question) {
  const normalizedQuestion = question.toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const step of script.steps) {
    const keywords = step.keywords || [];
    const score = keywords.reduce((current, keyword) => {
      return current + (normalizedQuestion.includes(String(keyword).toLowerCase()) ? 1 : 0);
    }, 0);

    if (score > bestScore) {
      best = step;
      bestScore = score;
    }
  }

  return best;
}

export function absoluteProductUrl(productUrl, maybeRelativeUrl) {
  return new URL(maybeRelativeUrl, productUrl).toString();
}
