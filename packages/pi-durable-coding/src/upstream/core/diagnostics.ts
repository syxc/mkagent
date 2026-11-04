// Ported from Pi v1.5.0 (f9a26365568127461c47a07a37dcb42c140a3ac5); MIT. See UPSTREAM.json and LICENSE.pi.
export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string; // skill name, command/tool/flag name, prompt name, theme name
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // e.g., "npm:foo", "git:...", "local"
	loserSource?: string;
}

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: ResourceCollision;
}
