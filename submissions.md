# MAFY MutaAgent Side Track Submission

## Project

MAFY is an AI-supported health operations console for Madagascar-focused programme work. It uses an anonymized sensitisation workbook to support outreach review, referral follow-up, data confidence checks, scenario planning, and downloadable reporting.

## Repository

- Main repository: https://github.com/ENZOMOTIVE/poverty_404
- Agent implementation: https://github.com/ENZOMOTIVE/poverty_404/tree/main/backend/src/agents
- Backend agent service notes: https://github.com/ENZOMOTIVE/poverty_404/tree/main/backend

## Documentation

- Agentic infrastructure: https://github.com/ENZOMOTIVE/poverty_404/blob/main/docs/AGENTIC_INFRASTRUCTURE.md
- Operations workflow overview: https://github.com/ENZOMOTIVE/poverty_404/blob/main/docs/OPERATIONS_OVERVIEW.md
- MutaAgent notes: https://github.com/ENZOMOTIVE/poverty_404/blob/main/backend/MUTAGENT.md
- Main project README: https://github.com/ENZOMOTIVE/poverty_404/blob/main/README.md

## Agentic Implementation Summary

The backend implements a coordinator-led multi-agent workflow. The `CoordinatorAgent` routes requests to specialist agents for data quality, outreach load, referral review, operational risk, follow-up planning, what-if forecasting, and report generation.

Specialist workflows include:

- `FollowUpOperationsAgent`: creates current follow-up actions with evidence, owners, due windows, blockers, and rationale.
- `WhatIfForecastAgent`: runs Monte Carlo scenario planning with parameter, simulation, and rationale sub-agents.
- `ReportAgent`: prepares report-ready summaries and export payloads from the dataset and specialist outputs.
- `DataQualityAgent`, `OutreachAgent`, `ReferralAgent`, and `RiskAgent`: provide evidence-grounded findings used by the coordinator and report workflow.

## Session Transcript Note

This submission includes the implemented agentic backend and workflow documentation. We did not use Helix directly, so no Helix transcript is included. The relevant subagent workflow is represented in the code and documentation links above, especially the MutaAgent notes and agentic infrastructure document.

## Frontend Deployment

Frontend deployment link is not included for this side-track submission.
