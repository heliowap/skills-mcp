# Skills MCP

An MCP server that keeps a catalog of agent skills out of the agent's context and hands the agent the one skill that fits its current task.

## Skills

**Skill**:
A directory of instructions for one kind of task, entered through its `SKILL.md`.
_Avoid_: Prompt, plugin, recipe

**Skill id**:
The name of a skill's directory, which identifies the skill across the whole catalog.
_Avoid_: Skill name, slug

**Description**:
The short text in a skill's frontmatter that says when the skill applies.
_Avoid_: Summary, blurb

**Body**:
The instructions in `SKILL.md` after the frontmatter.
_Avoid_: Content, prompt

**Resource**:
A text file inside a skill directory, other than `SKILL.md`, that the server can serve when the body points to it; binary and oversized files are not resources.
_Avoid_: Asset, attachment

**Skill directory**:
A directory that holds a `SKILL.md`; the unit a source contributes to the catalog.
_Avoid_: Skill folder, candidate

**Vendored copy**:
A second copy of a skill inside the same source, such as one under `upstream/` or `plugins/`, folded into the original.
_Avoid_: Duplicate, mirror

**Excerpt**:
The opening of a skill's body, used to tell similar skills apart.
_Avoid_: Preview, snippet

**Example task**:
A task description written to show when a skill applies, used to teach the trained ranker and to build expansions.
_Avoid_: Sample, test case, eval request

## Sources and catalog

**Source**:
A configured place skills come from: a GitHub source, a local source, or a command source.
_Avoid_: Provider, registry, repo

**GitHub source**:
A source that is a pinned revision of a GitHub repository.
_Avoid_: Remote, repo source

**Local source**:
A source that is a directory on the user's machine.
_Avoid_: Folder source, path source

**Trusted source**:
A source the user controls, whose skill directories may link to places outside it; local sources are trusted, GitHub and command sources are not.
_Avoid_: Safe source, private source

**Command source**:
A source whose skills are printed by a CLI that embeds them.
_Avoid_: CLI source, binary source

**Sync**:
Bringing a source's skills onto disk at its configured revision.
_Avoid_: Fetch, install, pull

**Catalog**:
The merged set of skills from all sources, with one skill per skill id.
_Avoid_: Index, roster, library

**Shadowed skill**:
A skill left out of the catalog because an earlier source has a skill with the same skill id.
_Avoid_: Duplicate, conflict

## Finding skills

**Task**:
The description of what the agent is about to do, which `find` matches against the catalog.
_Avoid_: Query, prompt, request

**Suggestion**:
The single skill, or none, that the classifier proposes for a task.
_Avoid_: Recommendation, pick, match

**Candidate**:
A skill still under consideration for a task, ranked by how well it fits.
_Avoid_: Option, hit

**Classifier**:
The part of the server that turns a task into candidates and a suggestion.
_Avoid_: Router, selector

**Lexical ranker**:
A ranker that scores candidates by shared words, with no model; also the fallback.
_Avoid_: Search, BM25 (as a concept name)

**Trained ranker**:
A ranker that scores candidates with weights learned offline from example tasks and stored as an artifact; unlike the lexical ranker, it can decide that no skill applies.
_Avoid_: ML ranker, model, classifier

**Teacher**:
The decision model whose answers decide which example tasks are kept for training.
_Avoid_: Labeler, oracle, gold model

**Expansion**:
Extra text added to a skill's lexical index from its example tasks, so a paraphrase can match a skill whose own text shares no words with it.
_Avoid_: Synonym, alias, tag

**Decision model**:
A model that answers typed questions with probabilities instead of generating text.
_Avoid_: LLM, classifier model, Jev (as a generic name)

**Decision protocol**:
A wire format for asking a decision model typed questions; System One and OpenAI Decisions are the two in use.
_Avoid_: API, provider

**Gate**:
The check that decides whether a task needs a skill at all before any skill is chosen.
_Avoid_: Filter, guard

**Shortlist**:
The few top candidates that are re-read in full before a suggestion is made.
_Avoid_: Top-k, finalists

**Fits check**:
The per-candidate yes/no judgement of whether a skill does what the task asks.
_Avoid_: Validation, verification

**Shard**:
One slice of the catalog small enough to be ranked in a single question.
_Avoid_: Chunk, batch, page

**Threshold**:
The probability a decision model's answer must reach before the classifier acts on it, set per model.
_Avoid_: Cutoff, confidence level

**Fallback**:
Answering a task with the trained or lexical ranker when the decision model is unavailable or fails.
_Avoid_: Degraded mode, offline mode

## Harness

**Harness**:
The agent application that connects to the server, such as OpenCode.
_Avoid_: Client, host, agent

**Native skill list**:
The list of skill descriptions a harness places in the agent's context on every model step.
_Avoid_: Skill index, available skills

**Fixed cost**:
The context the server occupies on every model step whether or not it is used.
_Avoid_: Overhead, footprint

**Cutover**:
Switching the user's harness from its native skill list and CLI-backed MCP servers to this server.
_Avoid_: Migration, rollout

**Coverage**:
The share of the harness's registered skills that the catalog can serve.
_Avoid_: Completeness, parity
