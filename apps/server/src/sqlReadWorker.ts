import { DatabaseSync } from "node:sqlite"
import { parentPort as port, workerData } from "node:worker_threads"

const { file, query }: { readonly file: string; readonly query: string } = workerData

const database = new DatabaseSync(file, { readOnly: true })

port?.postMessage(database.prepare(query).all())

database.close()
