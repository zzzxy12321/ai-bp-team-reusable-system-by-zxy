# AI-BP Team - Reusable System Built by ZXY

> 中文名：AI-BP 团队，zxy制作可复用系统

This public repository shares the AIDT reusable operating-system prototype and its supporting development standards with the AI-BP team.

## Repository contents

- `AIDT/` - AIDT business operating-system prototype, requirements, architecture, prompts, source code, tests, and test evidence.
- `coding/` - The 45 Markdown documents referenced by the development-standards catalog, covering project context, engineering standards, templates, and AI prompt playbooks.
- `AIDT-AI开发规范目录说明.xlsx` - The catalog and reading guide for the 45 Markdown documents.

Complete formal-system source is published separately at [ai-bp-team-aidt-platform](https://github.com/zzzxy12321/ai-bp-team-aidt-platform).

## Suggested reading order

1. Read `coding/AGENTS.md` and `coding/README.md`.
2. Read the project goal, requirements, architecture, and plan under `coding/`.
3. Read the role-specific standards under `coding/standards/`.
4. Use the reusable templates under `coding/templates/` and prompts under `coding/prompts/`.
5. For the executable local prototype, start with `AIDT/LOCAL-MVP/README.md`.

## Documentation migration note

Four project documents were moved in the working workspace after the catalog was created. They were copied to the paths listed in the catalog:

- `coding/docs/001-产品PRD/00-项目目标.md` -> `coding/00-项目目标.md`
- `coding/docs/001-产品PRD/01-需求基线.md` -> `coding/01-需求.md`
- `coding/docs/001-产品PRD/02-技术栈与架构.md` -> `coding/02-技术栈与架构.md`
- `coding/docs/001-产品PRD/03-计划方案.md` -> `coding/03-计划方案.md`

## Public-sharing boundary

This repository is public. The AIDT prototype uses demo data and mock external systems. Do not add real formulas, customer data, costs, quotations, process parameters, credentials, interface keys, or production data.

The local runtime database, generated PID files, and other ignored runtime artifacts are not part of the published repository.
