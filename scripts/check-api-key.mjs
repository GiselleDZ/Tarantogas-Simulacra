import { readFileSync } from "fs";
import yaml from "js-yaml";
import Anthropic from "@anthropic-ai/sdk";

const config = yaml.load(readFileSync("config/simulacra.yaml", "utf-8"));
const apiKey = config?.anthropic?.api_key ?? process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error("No API key found. Set anthropic.api_key in config/simulacra.yaml or ANTHROPIC_API_KEY env var.");
  process.exit(1);
}

const masked = apiKey.slice(0, 12) + "..." + apiKey.slice(-4);
console.log(`Testing key: ${masked}`);

const client = new Anthropic({ apiKey });

try {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    messages: [{ role: "user", content: "Say OK" }],
  });

  console.log("✓ API key is valid and has credits.");
  console.log(`  Model: ${response.model}`);
  console.log(`  Usage: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens`);
} catch (err) {
  if (err?.status === 401) {
    console.error("✗ Invalid API key — authentication failed.");
  } else if (err?.status === 402) {
    console.error("✗ No credits — your account balance is zero.");
  } else if (err?.status === 429) {
    console.error("✗ Rate limited or over quota.");
  } else {
    console.error("✗ API call failed:", err?.message ?? err);
  }
  process.exit(1);
}
