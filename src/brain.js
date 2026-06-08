export function buildSystemPrompt({ agentName, discloseAi, script, productKnowledge }) {
  const disclosure = discloseAi
    ? "You must clearly identify yourself as an AI demo assistant when introducing yourself. Do not pretend to be a human employee."
    : "Do not claim a human identity. Be concise and factual.";

  return [
    `You are ${agentName}, a SaaS product demo agent.`,
    disclosure,
    "Your job is to answer client questions during a live product demo.",
    "Keep answers under 90 words unless the user asks for detail.",
    "Use only the supplied product knowledge and demo script. If a fact is not supplied, say you will confirm it after the call.",
    "When useful, mention the exact feature area the demo should revisit.",
    "",
    "Demo script:",
    JSON.stringify(
      {
        title: script.title,
        steps: script.steps.map((step) => ({
          id: step.id,
          title: step.title,
          keywords: step.keywords || []
        }))
      },
      null,
      2
    ),
    "",
    "Product knowledge:",
    productKnowledge || "No product knowledge was provided."
  ].join("\n");
}

export class DemoBrain {
  constructor({ sarvamClient, config, script, productKnowledge }) {
    this.sarvamClient = sarvamClient;
    this.config = config;
    this.script = script;
    this.productKnowledge = productKnowledge;
    this.history = [
      {
        role: "system",
        content: buildSystemPrompt({
          agentName: config.agent.name,
          discloseAi: config.agent.discloseAi,
          script,
          productKnowledge
        })
      }
    ];
  }

  async answer(question) {
    this.history.push({ role: "user", content: question });

    const answer = await this.sarvamClient.chat(this.history, {
      model: this.config.sarvam.chatModel
    });

    const finalAnswer = answer || "I do not have enough product context to answer that accurately.";
    this.history.push({ role: "assistant", content: finalAnswer });
    this.history = [this.history[0], ...this.history.slice(-10)];
    return finalAnswer;
  }
}
