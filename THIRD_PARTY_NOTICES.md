# Third-party notices

## Libre Franklin

The interface typeface under `src/assets/fonts/sans.woff2` is Libre Franklin.

Copyright 2020 The Libre Franklin Project Authors (https://github.com/googlefonts/Libre-Franklin).

https://fonts.google.com/specimen/Libre+Franklin

It is distributed under the SIL Open Font License 1.1. The complete licence is included at
`src/assets/fonts/OFL-LibreFranklin.txt`. The bundled file is a subset of the upstream variable
font from the official Google Fonts repository, restricted to the character set this interface
renders; the upright weight axis 100 to 900 is kept in full.

## Martian Mono

The monospaced typeface under `src/assets/fonts/mono.woff2` is Martian Mono.

Copyright © 2021 The Martian Mono Project Authors, by Roman Shamin at Evil Martians.

https://github.com/evilmartians/mono

It is distributed under the SIL Open Font License 1.1. The complete licence is included at
`src/assets/fonts/OFL-MartianMono.txt`. The bundled file is a subset of the upstream variable font,
instanced to the narrow width and restricted to weights 300 to 700.

## Service artwork

The service-identification artwork under `src/assets/icons` was sourced from the Dashboard Icons project:

https://github.com/homarr-labs/dashboard-icons

Copyright © 2024 Bjorn Lammers, Meier Lukas, Thomas Camlong and Homarr Labs.

The artwork is distributed under the Apache License 2.0. The complete licence is included at
`src/assets/icons/LICENSE`, and the attribution retained in distributed images is at
`src/assets/icons/NOTICE`.

Product names, logos, trademarks and registered trademarks remain the property of their respective
owners. They are used only to identify compatible services. Their inclusion does not imply endorsement
by those owners or by the Dashboard Icons maintainers.

## EFF Long Wordlist

`src/mobile/eff_large_wordlist.txt` is the Electronic Frontier Foundation's large Diceware wordlist.

Created by Joseph Bonneau for the Electronic Frontier Foundation.

https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt

EFF publishes its original website material under the Creative Commons Attribution 4.0 International
licence unless otherwise noted:

https://www.eff.org/copyright

https://creativecommons.org/licenses/by/4.0/

The file is included without modification. Its SHA-256 digest is
`addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e`.

## Docker Socket Proxy

`Dockerfile.socket-proxy` derives from Tecnativa's Docker Socket Proxy v0.5.0:

https://github.com/Tecnativa/docker-socket-proxy

The pinned base image digest is
`sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459`.
The upstream project is distributed under the Apache License 2.0. The complete licence text is
included at `src/assets/icons/LICENSE` and copied into the derived image as
`/usr/share/licenses/qm-companion/APACHE-2.0.txt`.

Quartermaster's derived image modifies the upstream HAProxy template. It adds a shared-header
authentication gate, gives the Docker event backend a finite idle timeout, rejects `HEAD`, and
blocks container archive and export routes before the upstream allow rules.

## JavaScript packages

Runtime packages installed from `package-lock.json` retain their own copyright notices and licences.
Their licence files are included in the installed packages and container image where supplied upstream.
