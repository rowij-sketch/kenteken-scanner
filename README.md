# Kenteken Scanner

Webapp die een Nederlands kenteken van een foto leest en de voertuiggegevens ophaalt uit de open data van de RDW.

- Werkt voor iedereen zonder account of API-sleutel, op telefoon (camera) en computer (foto kiezen of typen).
- De foto wordt alleen in de browser gelezen (Tesseract.js). Alleen het kenteken gaat naar `opendata.rdw.nl`.
- Volledig statisch: geen server-code, geen build-stap. Tesseract.js, de WebAssembly-kern en de Engelse taaldata staan in `vendor/`, dus er is geen afhankelijkheid van een externe CDN.
- Deelbare links: `/?kenteken=GX434R` zoekt direct op.

## Hoe het werkt

1. Foto inladen en verkleinen tot max. 1600 px.
2. `vision.js` zoekt het grootste gele, langwerpige vlak (de kentekenplaat) en bepaalt de hoek daarvan. De gebruiker kan ook zelf een kader slepen; daarbinnen wordt opnieuw naar de gele plaat gezocht.
3. De plaat wordt rechtgezet en naar zwart-wit omgezet, op twee manieren (Otsu en een geelmasker). Alleen vlekken met de vorm van letters, cijfers en streepjes blijven over, zodat de blauwe NL-strook en de plaatrand wegvallen. De schuine stand van de letters (door perspectief) wordt rechtgetrokken.
4. Beide varianten gaan als één regel door de OCR; de kandidaten van de zekerste lezing komen eerst. Lukt het niet, dan wordt de hele foto doorzocht.
5. `plate.js` maakt van de OCR-tekst kandidaten die passen op de Nederlandse sidecodes en corrigeert verwisselingen als 0/D en 8/B.
6. Alle kandidaten in één verzoek opzoeken bij de RDW (`m9d7-ebf2`). De eerste die bestaat wordt getoond, aangevuld met brandstof en uitstoot (`8ys7-d773`).

## Lokaal draaien

```sh
cd kenteken-scanner
python3 -m http.server 8000
```

Open daarna http://localhost:8000. De camera-knop werkt op een telefoon alleen via HTTPS of localhost.

## Tests

```sh
node --test kenteken-scanner/tests/plate.test.js
```

## Uitrol

Kopieer de hele map naar een webserver die statische bestanden serveert over HTTPS. Aandachtspunten:

- `.wasm.js`-bestanden als `application/javascript` serveren en `.gz` **zonder** `Content-Encoding: gzip`. Tesseract pakt `eng.traineddata.gz` zelf uit.
- Bij een Content-Security-Policy moeten deze waarden zijn toegestaan: `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `connect-src 'self' https://opendata.rdw.nl` en `img-src 'self' blob: data:`.
- Lange cache voor `vendor/` (ongeveer 10 MB, verandert zelden), korte cache voor de rest.

## Live: kenteken.newro.nl (VPS20)

- Uitgerold vanaf een vast commit. Welk commit live staat, staat in `versie.json` in de releasemap. Een nieuwe versie gaat live door het nieuwe commit-hash door te geven aan het VPS20-beheer.
- **Camera:** de server stuurt `Permissions-Policy: camera=()`. Dat is goed zolang de app de bestandskiezer gebruikt (`<input type="file" capture>`), want die opent de camera-app van het toestel en valt niet onder dat beleid. Stapt de app over op `getUserMedia` (bijvoorbeeld voor een live camerabeeld), dan blokkeert die kop de camera zonder duidelijke foutmelding. Laat de server dan eerst `camera=(self)` zetten.
