export class MissingLogin extends Error {
  constructor(
    readonly login: string,
    readonly fix: string,
  ) {
    super(`Missing login: ${login}. Run \`${fix}\`.`)
    this.name = "MissingLogin"
  }
}

export class NoCapacity extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NoCapacity"
  }
}
