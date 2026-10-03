/**
 * Per-Agent installation state: what has been registered for an Agent, and the
 * directory set its discovery currently needs watched.
 *
 * Installing is asynchronous and can be triggered from three directions at once
 * (`agent/created`, a definition-directory watcher, and the activation sweep
 * over Agents that already existed), so one Agent's installs run in a single
 * chain: an earlier step always finishes before the next begins, and a step that
 * resolves after its Agent was disposed registers nothing. Without that order,
 * two overlapping installs could both register a tool, and the second would be
 * rejected as a duplicate while the first one leaked.
 * @module dsh-agents-toml/installation
 */
import type { AgentLike, FiberLike } from './host.ts'

/** What one install step produced. */
export interface InstallationOutcome {
  /** The registration owning this Agent's tool, when the step installed one. */
  readonly fiber?: FiberLike | undefined
  /** Directories a watcher must observe for this Agent's definitions to stay current. */
  readonly watchedDirs: readonly string[]
}

/** One install step, run only when its Agent is still live. */
export type InstallationStep = () => Promise<InstallationOutcome>

/** Where an install step's failure goes; it never rejects the caller. */
export interface InstallationSink {
  /** @param agent - the Agent whose install failed. @param error - the failure. */
  installFailed(agent: AgentLike, error: unknown): void
  /** @param agent - the Agent whose registration could not be released. @param error - the failure. */
  disposeFailed(agent: AgentLike, error: unknown): void
}

interface Entry {
  readonly agent: AgentLike
  /** Serializes this Agent's installs; never rejects. */
  chain: Promise<void>
  fiber?: FiberLike | undefined
  watchedDirs: readonly string[]
  disposed: boolean
}

/** The set of live per-Agent installations. */
export class Installations {
  private readonly entries = new Map<AgentLike, Entry>()
  private readonly sink: InstallationSink

  /** @param sink - where install and disposal failures are reported. */
  constructor(sink: InstallationSink) {
    this.sink = sink
  }

  /**
   * Run one install step for an Agent, after every earlier step for it.
   * @param agent - the Agent whose tool is being installed.
   * @param step - performs discovery and installation.
   * @returns settlement of this step; failures reach the sink.
   */
  async sync(agent: AgentLike, step: InstallationStep): Promise<void> {
    const entry = this.entries.get(agent) ?? this.open(agent)
    entry.chain = entry.chain.then(() => this.run(entry, step))
    await entry.chain
  }

  /**
   * Drop an Agent's installation and register nothing further for it.
   * @param agent - the disposed Agent.
   * @returns settlement after its registration is released.
   */
  async forget(agent: AgentLike): Promise<void> {
    const entry = this.entries.get(agent)
    if (entry === undefined) return
    this.entries.delete(agent)
    entry.disposed = true
    await entry.chain
    const fiber = entry.fiber
    entry.fiber = undefined
    if (fiber !== undefined) await this.release(entry, fiber)
  }

  /** @returns the Agents with a live installation entry. */
  agents(): readonly AgentLike[] {
    return [...this.entries.values()].map(entry => entry.agent)
  }

  /** @returns the union of the directories these Agents need watched. */
  watchedDirs(): readonly string[] {
    const dirs = new Set<string>()
    for (const entry of this.entries.values()) for (const dir of entry.watchedDirs) dirs.add(dir)
    return [...dirs]
  }

  /**
   * Release every registration and stop tracking.
   * @returns settlement after each registration is disposed.
   */
  async dispose(): Promise<void> {
    for (const agent of this.agents()) await this.forget(agent)
  }

  private open(agent: AgentLike): Entry {
    const entry: Entry = { agent, chain: Promise.resolve(), watchedDirs: [], disposed: false }
    this.entries.set(agent, entry)
    return entry
  }

  private async run(entry: Entry, step: InstallationStep): Promise<void> {
    const previous = entry.fiber
    entry.fiber = undefined
    if (previous !== undefined) await this.release(entry, previous)
    if (entry.disposed) return
    let outcome: InstallationOutcome
    try {
      outcome = await step()
    } catch (error) {
      this.sink.installFailed(entry.agent, error)
      entry.watchedDirs = []
      return
    }
    if (entry.disposed) {
      if (outcome.fiber !== undefined) await this.release(entry, outcome.fiber)
      return
    }
    entry.fiber = outcome.fiber
    entry.watchedDirs = outcome.watchedDirs
  }

  private async release(entry: Entry, fiber: FiberLike): Promise<void> {
    try {
      await fiber.dispose()
    } catch (error) {
      this.sink.disposeFailed(entry.agent, error)
    }
  }
}
