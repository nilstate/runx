import { parseSkillMarkdown, validateSkill, type ValidatedSkill } from "./index.js";

export interface SkillInstallOrigin {
  readonly source: string;
  readonly source_label: string;
  readonly ref: string;
  readonly skill_id?: string;
  readonly version?: string;
  readonly digest?: string;
  readonly profile_digest?: string;
  readonly runner_names?: readonly string[];
  readonly trust_tier?: string;
}

export interface ValidatedSkillInstall {
  readonly skill: ValidatedSkill;
  readonly origin: SkillInstallOrigin;
  readonly markdown: string;
}

export function validateSkillInstall(markdown: string, origin: SkillInstallOrigin): ValidatedSkillInstall {
  const raw = parseSkillMarkdown(markdown);
  const skill = validateSkill(raw, { mode: "strict" });
  return {
    skill,
    origin,
    markdown,
  };
}
