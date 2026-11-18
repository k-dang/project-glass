export interface Size {
  readonly width: number
  readonly height: number
}

export interface Shot extends Size {
  readonly id: string
  readonly area: string
  readonly name: string
  readonly focus: Size | null
}
