/** A SKILL.md with the frontmatter a program loads it by. */
export const skillFile = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name} well.\n`
