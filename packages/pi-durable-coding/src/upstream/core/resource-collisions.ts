// Ported from Pi v1.5.0 (f9a26365568127461c47a07a37dcb42c140a3ac5); MIT. See UPSTREAM.json and LICENSE.pi.
import type { PromptTemplate } from "./prompt-templates.ts";
import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";

export function dedupePrompts(prompts: PromptTemplate[]): {
    prompts: PromptTemplate[];
    diagnostics: ResourceDiagnostic[];
} {
    const seen = new Map<string, PromptTemplate>();
    const diagnostics: ResourceDiagnostic[] = [];
    for (const prompt of prompts) {
        const existing = seen.get(prompt.name);
        if (existing) {
            diagnostics.push({
                type: "collision",
                message: `name "/${prompt.name}" collision`,
                path: prompt.filePath,
                collision: {
                    resourceType: "prompt",
                    name: prompt.name,
                    winnerPath: existing.filePath,
                    loserPath: prompt.filePath,
                },
            });
        }
        else {
            seen.set(prompt.name, prompt);
        }
    }
    return { prompts: Array.from(seen.values()), diagnostics };
}
