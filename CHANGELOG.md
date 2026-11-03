# Changelog

All notable changes to the Cloudflare edge-router worker are recorded here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers are the worker's `EDGE_SCRIPT_VERSION`.

## [0.15.0] - 2026-10-26

### Added

- Optional `ORIGIN` Service Binding passthrough. When another Worker already serves the hostname, bind it as `ORIGIN` and the router hands origin-bound requests to that Worker directly. Installs without the binding keep the plain same-zone fetch.
- If the binding throws, the router falls back to a plain fetch, so a broken binding degrades to the origin rather than an error page.
- The health response reports `origin_binding`, so an install's mode is observable.
- The README documents how to set up the binding.

## [0.14.2] - 2026-10-14

### Fixed

- The capture binding is now part of the feed cache key. A worker converted from capture to mirror no longer keeps recording on a stale cached feed, which could otherwise last up to an hour.

## [0.14.1] - 2026-10-14

### Fixed

- The colo feed cache is now keyed per site, so NORG sites sharing a zone no longer read each other's feed. An install with no `SITE_ID` keeps the legacy key.

## Earlier versions

Versions up to 0.14.0 are recorded in the git commit history.
