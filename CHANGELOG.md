# Changelog

## [0.3.4](https://github.com/dan-rozhkov/browser-agent/compare/v0.3.3...v0.3.4) (2026-10-21)


### Features

* **trace:** request log, batch actions and a frame after a failed step ([d531838](https://github.com/dan-rozhkov/browser-agent/commit/d531838bd23ca0d2c62813a393d048af658636dd))

## [0.3.3](https://github.com/dan-rozhkov/browser-agent/compare/v0.3.2...v0.3.3) (2026-10-21)


### Bug Fixes

* **trace:** no typed secrets in trace.qa, page-load errors on the open step ([a560596](https://github.com/dan-rozhkov/browser-agent/commit/a5605965403aba8080bd783e9bca68f95680b186))

## [0.3.2](https://github.com/dan-rozhkov/browser-agent/compare/v0.3.1...v0.3.2) (2026-10-20)


### Features

* **agent:** browse run trace format and recorder ([bdbf4c9](https://github.com/dan-rozhkov/browser-agent/commit/bdbf4c9451b56ac86b79ac8b298d9b8b21289962))

## [0.3.1](https://github.com/dan-rozhkov/browser-agent/compare/v0.3.0...v0.3.1) (2026-10-20)


### Bug Fixes

* **electron:** drive the app window, not an empty service window ([6dc8618](https://github.com/dan-rozhkov/browser-agent/commit/6dc86181e1fd4f3bf1ee1bd9e2cd42a1b0705dbd))

## [0.3.0](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.29...v0.3.0) (2026-10-20)


### ⚠ BREAKING CHANGES

* **cursor:** BrowserController no longer accepts `cursorMotion`.

### Features

* **cursor:** one agent cursor motion ([f196795](https://github.com/dan-rozhkov/browser-agent/commit/f196795f9249678bded44b31b09ab6713d58b707))

## [0.2.29](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.28...v0.2.29) (2026-10-20)


### Bug Fixes

* **electron:** a failed launch on the user's profile does not kill the app ([3965410](https://github.com/dan-rozhkov/browser-agent/commit/396541010a70238f8ed3cba26d2082b5b754c63a))

## [0.2.28](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.27...v0.2.28) (2026-10-20)


### Bug Fixes

* **electron:** never kill an app that runs on the user's profile ([7682a45](https://github.com/dan-rozhkov/browser-agent/commit/7682a45b6ff8b22db3347c3e4fceea4d8ae78959))

## [0.2.27](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.26...v0.2.27) (2026-10-20)


### Features

* **electron:** work with an app the user already has open ([db10f65](https://github.com/dan-rozhkov/browser-agent/commit/db10f651e9e18cf7b2f9fcc4a3fd15b7b7bbc301))

## [0.2.26](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.25...v0.2.26) (2026-10-19)


### Features

* **agent:** opt-in browse_open app field to launch a desktop app ([2ac2093](https://github.com/dan-rozhkov/browser-agent/commit/2ac2093ed99ff1a07f819d3ec8024a78634b234b))

## [0.2.25](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.24...v0.2.25) (2026-10-19)


### Features

* **adapters:** drive Electron desktop apps over CDP (launchElectronApp) ([9f9b50a](https://github.com/dan-rozhkov/browser-agent/commit/9f9b50a9bd7fbbb964f0f136b6d1341e19903934))

## [0.2.24](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.23...v0.2.24) (2026-10-19)


### Features

* **agent:** qa.judge — a second model reviews a passed QA outcome ([fa8645d](https://github.com/dan-rozhkov/browser-agent/commit/fa8645d1f271ce14047ddb493a46f530a39900f4))

## [0.2.23](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.22...v0.2.23) (2026-10-18)


### Features

* **agent:** browse_act viewport action to change device emulation mid-run ([180243d](https://github.com/dan-rozhkov/browser-agent/commit/180243d97a213e8d7946bc17f86292473e3cd00e))

## [0.2.22](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.21...v0.2.22) (2026-10-18)


### Bug Fixes

* emulation fidelity and data-URL screenshots found by the live smoke ([6de0ccb](https://github.com/dan-rozhkov/browser-agent/commit/6de0ccbaf9bfef8e10a6100353cc1223ffabf9c4))

## [0.2.21](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.20...v0.2.21) (2026-10-18)


### Features

* QA diagnostics, deterministic checks, device emulation and file upload ([eb82ee1](https://github.com/dan-rozhkov/browser-agent/commit/eb82ee1a77ea6c1ecf111ec48c7f63c5200651fb))

## [0.2.20](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.19...v0.2.20) (2026-10-17)


### Bug Fixes

* **agent:** QA prompt lets the scenario submit forms and ends on the verdict ([a5753b1](https://github.com/dan-rozhkov/browser-agent/commit/a5753b1c2f1ad74f4c39f75df8db7fe4620994b7))

## [0.2.19](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.18...v0.2.19) (2026-10-17)


### Features

* **agent:** zod-free QA core in agent/session, endsRun hook ([8e675fb](https://github.com/dan-rozhkov/browser-agent/commit/8e675fb7d0282c5ea590446cc6dbc70ecaf10699))

## [0.2.18](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.17...v0.2.18) (2026-10-17)


### Features

* **agent:** QA mode in runBrowseAgent, replaces runQaSuite ([d50018b](https://github.com/dan-rozhkov/browser-agent/commit/d50018b52b0a8be0d48ceb422bae2b6f32eccffe))

## [0.2.17](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.16...v0.2.17) (2026-10-16)


### Features

* **agent:** createRunCheckpoint, the run-end checkpoint lifecycle ([1a7c13b](https://github.com/dan-rozhkov/browser-agent/commit/1a7c13b7399e9cee1c6f7b9a638f1a6c345a86d1))

## [0.2.16](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.15...v0.2.16) (2026-10-16)


### Features

* **fixture:** mid-task checkpoint journal ([f26532c](https://github.com/dan-rozhkov/browser-agent/commit/f26532c302a57de24e53da715f01c15026087197))

## [0.2.15](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.14...v0.2.15) (2026-10-15)


### Bug Fixes

* **agent:** release fixture mocks that arrive after the run ended ([27cfa95](https://github.com/dan-rozhkov/browser-agent/commit/27cfa95c8367977fe272c65eff2f3baf6c612355))

## [0.2.14](https://github.com/dan-rozhkov/browser-agent/compare/v0.2.13...v0.2.14) (2026-10-15)


### Features

* **fixture:** PageFixture core — prepare browser state before a task ([13f9494](https://github.com/dan-rozhkov/browser-agent/commit/13f94941697b4a560a8da049eb8389daccee33b4))
* **fixture:** QA start — expect, network mocks, fresh session ([479d3d3](https://github.com/dan-rozhkov/browser-agent/commit/479d3d3e3c82ae6cdfef4f31afb6a48c44c88194))
