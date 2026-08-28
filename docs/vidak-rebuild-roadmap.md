# Vidak Rebuild Roadmap

## Purpose

Vidak will become an eVault-first video library and publishing tool. Its core job is simple: help a person find video they are authorised to access, understand its current visibility, and deliberately keep it private, share it, or publish it.

This roadmap replaces platform-first language and unexplained protocol mechanics with a user journey built around ownership, access, and clear outcomes. W3DS remains the underlying capability; it is not the interface a person has to decode.

## Product contract

A person should be able to complete this journey without prior W3DS knowledge:

1. Open Vidak and immediately understand what it is for.
2. See the video available through the eVaults they are authorised to access.
3. See whether each video is private, shared, or public.
4. Choose a visibility action and understand its consequence before approval.
5. Upload a new video without having to prepare a thumbnail or invent a spoken language.

Vidak must not imply that a video belongs to, or can only be found through, the app that originally created it. A source application may be shown as optional provenance, but video discovery is based on authorised eVault data.

## Principles

- Start with a useful action, not a feed-shaped empty screen.
- Use human-readable names first; technical identifiers are secondary.
- Make privacy the default and publishing an explicit choice.
- Explain the exact claim before a signature is requested.
- Never copy source media merely to list or play an authorised video.
- Hide unavailable integrations instead of presenting dead controls.
- Keep protocol-specific language behind contextual help.

## Release 0 — Trust and clarity

### Goal

A first visit looks reliable and every visible action has an understandable result.

### Work

- Replace broken or misleading home-page preview cards with a reliable empty state and two actions: Find my videos and Upload a video.
- Display the person’s display name in the application shell. Keep the eName only in identity and account detail.
- Remove the Meshenger label from primary navigation and user-facing explanations. Preserve legacy links through redirects.
- Rename Connected accounts to External channel links (optional); hide providers that cannot currently be used.
- Repair the eID signing payload’s text encoding and introduce an end-to-end Cyrillic approval test.
- Show the exact, content-derived approval statement before QR signing and in the confirmation result.

### Acceptance criteria

- No initial screen contains a broken player, failed thumbnail, or inactive primary control.
- A user can state what Vidak does after the first screen: find video in my authorised eVaults and choose its visibility.
- A Cyrillic signing request renders legibly in the eID flow and the text shown before approval matches the signed statement.

## Release 1 — Your eVault videos

### Goal

Make the library the primary product surface, not a side menu.

### Work

- Introduce a single eVault video discovery service that enumerates accessible video records from a person’s own and authorised group eVaults.
- Normalise discovered records into an internal catalogue with title, playable source, timestamp, available preview, access scope, and optional provenance.
- Classify video by content purpose where the metadata allows it: call recording, video message, uploaded file, or other video. Never require a source application to appear in the UI.
- Build Your videos as the default authenticated destination, with filters for All, Call recordings, Video messages, Uploaded files, and Shared with me.
- Make loading, empty, permission-needed, and retry states specific and actionable.

### Security boundary

- Query only eVault data that the signed-in person is already authorised to read.
- Do not persist media files in Vidak merely to index them.
- Store only the minimum catalogue metadata required for a fast library; preserve the source record as the authority.
- Model group-vault access explicitly so a user never sees content they cannot open.

### Acceptance criteria

- A person with authorised call recordings and video files can find them in one library without navigating to a source application.
- The library makes it clear why an item is available and whether it can be played or shared.
- No user-facing copy says that Vidak connects directly to Meshenger.

## Release 2 — Visibility and publishing

### Goal

Turn Vidak into the place where a person controls how their video is seen.

### Work

- Add visibility status and actions to every catalogue item: Keep private, Share with selected people, and Publish publicly.
- Build a review screen that describes audience, source title, and the exact next effect before signing.
- Record publication state and allow a clear, reversible unpublish action.
- Keep discovery separate from publishing: finding a video never changes its visibility.

### Acceptance criteria

- A user can locate one authorised video, keep it private, then publish it, and see the correct state after each action.
- The signature copy contains the human-readable video title and requested visibility effect.

## Release 3 — Upload that completes itself

### Goal

Uploading a video should require video and intent, not avoidable preparation work.

### Work

- Generate a thumbnail from a stable video frame during processing. Keep custom thumbnail upload as an optional override.
- Surface processing progress and a recoverable processing failure state.
- Make language optional and add No speech / music only.
- Carry the selected visibility into the same clear review and signing flow used for discovered videos.

### Acceptance criteria

- A user can upload music-only video, receive an automatically generated preview, and publish without selecting a spoken language.

## Release 4 — Optional external channel links

### Goal

External links enhance a person’s library without disguising what is supported.

### Work

- Keep public YouTube channel links as an immediate, no-copy catalogue action.
- Enable owner-authorised YouTube and Vimeo links only when the provider configuration and OAuth callback path are fully live.
- Explain whether Vidak lists, embeds, or imports metadata from an external provider.
- Never show disabled Connect controls as the primary action.

## Delivery sequence

1. Audit the existing home, application shell, library, eVault discovery, upload, and signing paths against this roadmap.
2. Ship Release 0 as a focused trust repair with regression coverage.
3. Implement and verify the eVault discovery contract before rebuilding the library UI.
4. Ship Releases 1 and 2 together as the first coherent Vidak product loop.
5. Add upload automation and external links after the core eVault experience is dependable.

## Test matrix required before each release

- First-time user with no available videos.
- User with personal-vault and authorised group-vault video.
- Call recording, video message, and generic video file.
- Private, shared, and public visibility transitions.
- Music-only upload with generated preview.
- Cyrillic and English approval statements in the eID flow.
- Small mobile viewport and a slow or failed network request.

## Explicit non-goals for the rebuild

- Recreating YouTube’s feed, subscription, or recommendation model before the eVault library works.
- Treating any source application as the owner of a person’s data.
- Auto-publishing, auto-sharing, or copying private source media.
- Adding social or federation features before the find-and-control-video loop is complete.

## Status

Releases 1 and 3 are deployed. The eVault-first entry point, legacy-route redirect, actionable home empty state, clearer settings language, social metadata, and a source-neutral eVault library endpoint are live. The library includes standard W3DS upload records from personal and authorised group eVaults, alongside recognised call and video-message metadata. Vidak uploads now support saved-draft recovery, automatic previews, optional spoken language, clear signing text, and reversible public, link-only, or private publication.

Release 2 is complete for videos uploaded to Vidak: a person can see each local video’s status, continue a draft, watch an eligible shared video, or return a published video to a draft before changing it. Vidak does not present share controls for arbitrary eVault-discovered video: the current official W3DS authorization client boundary cannot safely mutate a source eVault ACL, and the interface states that source sharing rules remain unchanged. The first empty library view now explains the two supported paths rather than leaving a person to infer them.
