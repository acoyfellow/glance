# Security

Glance is a local filesystem observer. It is designed to run on your own computer and bind only to `127.0.0.1`.

## What it reads

Given the configured `root`, Glance observes:

- repository status and recent file activity beneath that root;
- optional event and Markdown receipt files under the configured `contextDir`.

Glance does not expose action endpoints and does not intentionally read environment-variable files, cache directories, build output, credential files, or coding-agent conversation stores. Do not place secrets in paths you intend to display in a browser.

Orb may request microphone and camera access only after an explicit browser interaction to power local ambient/gesture effects. Media is processed within the page and is not uploaded or written by the Glance server.

## Deployment guidance

Do not deploy Glance on a public interface without designing authentication and data filtering for your environment. Its UI can reveal filenames, repository names, and activity metadata.

## Reporting issues

For a suspected security issue, contact the repository owner privately rather than opening a public issue with sensitive details.
