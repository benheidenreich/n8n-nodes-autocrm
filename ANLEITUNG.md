# autocrm-Node für n8n — deutsche Anleitung

Diese Node spricht die **autocrm-API3, Schnittstellenversion 3.5** (IMAGO Informationstechnologie GmbH) und deckt die Leadverteilung ab: Lead anlegen, zuweisen, E-Mails und Notizen am Lead dokumentieren, Existenz prüfen.

Installation: siehe `ANLEITUNG-DOCKER.md` (lokales Paket) bzw. README (npm).

## 1. Credentials

| Feld | Bedeutung |
|---|---|
| Base URL | `https://www.autocrm.de/api/api3` — nur ändern, wenn der Support etwas anderes vorgibt |
| Username / Password | API-User vom autocrm-Support (HTTP Basic Auth) |

- **Nur ein Request gleichzeitig pro API-User** (Serverregel). Die Node serialisiert ihre Aufrufe innerhalb einer n8n-Instanz selbst; trotzdem: einen **eigenen API-User nur für n8n** verwenden und denselben User nicht parallel aus anderen Systemen benutzen.
- Der **Credential-Test** macht einen echten, rein lesenden API-Aufruf (`AnfrageVorhanden` mit Lead-ID 1). Jede JSON-Antwort des Servers beweist gültige Zugangsdaten — auch die Meldung „Credentials are valid (server responded with fehler_berechtigung)" ist also ein **Erfolg** (der API-User darf nur diese eine Funktion nicht).

## 2. Operation Create (API: `NeueAnfrage`)

Legt Lead **und** Kontakt in einem Aufruf an. Durchsatzgrenze: **3 pro 60 Sekunden** — der Engpass bei Massenimporten.

Pflichtfelder: Contact ID, Last Name, mindestens eines von Email/Phone/Mobile, Branch ID, Category, First Contact Channel, Source, Note Title, Note Content.

### Die zentrale Falle: Contact ID ist ein Upsert-Schlüssel

`Contact ID` = `x-id-kontakt` = **eure eigene** Kunden-ID. autocrm prüft damit, ob der Kontakt schon existiert:

- **Existiert er**, wird der Lead an den bestehenden Kontakt gehängt und **alle anderen Kontaktfelder werden stillschweigend verworfen** (Ausnahme: License Plate / `kfz-kennzeichen`). Das passiert mit HTTP 200 — kein Fehler!
- **Kollisionswarnleuchte:** Im Output `neuer-kontakt` auswerten. Steht dort `false`, obwohl ihr die ID gerade frisch erzeugt habt, ist der Lead bei einer **fremden Person** gelandet.
- Die Vergabe-Regeln für `x-id-kontakt` (erlaubte **Präfix-Bereiche**, Verhalten bei Verletzung) sind eine **offene Frage an den autocrm-Support** — vor dem Produktivstart klären (siehe Projekt Leadverteilung, `NACHTRAG-SUPPORT_Kontakt-IDs.md`).
- Eine vergebene `x-id-kontakt` ist **nicht änderbar**, und es gibt keine API-Funktion, um Kontakte zu suchen — die Dublettenerkennung liegt komplett bei euch.

### Weitere Hinweise

- **Assignee Email** (`bearbeiter`, unter Additional Lead Fields) erwartet die **autocrm-Login-Adresse** des Mitarbeiters — nicht die Autohaus-Adresse. (Genau umgekehrt zur Assign-Operation, siehe unten.)
- **Zeitstempel** (Process From/By, Close By) werden automatisch in deutsche Lokalzeit (Europe/Berlin) im Format `2026-01-15 10:30:00` umgerechnet — n8n-Datumswerte einfach durchreichen.
- **Rufnummern** brauchen das internationale Format `+496301708123456`. Übliche Trennzeichen (Leerzeichen, Bindestrich, Klammern, Punkt, Schrägstrich) entfernt die Node selbst, `00`-Präfix wird zu `+`. Nationale Nummern ohne Landesvorwahl lehnt sie mit klarer Fehlermeldung ab.
- **Vehicle** nur befüllen, wenn die Category in autocrm als **Fahrzeuganfrage** konfiguriert ist; bei LMS-Kategorien muss das Objekt weggelassen werden. Kennt autocrm die Vehicle ID (`x-id-fahrzeug`) bereits, wird das bestehende Fahrzeug verknüpft und Description ignoriert.
- Gültige Werte für **Branch ID**, **Source** und die **Category-Pfade** sind mandantenspezifisch → beim autocrm-Support erfragen.

### Output

| Feld | Bedeutung |
|---|---|
| `id-anfrage` | Die Lead-ID — Schlüssel für alle Folge-Operationen. **Persistieren!** |
| `id-kontakt` | autocrm-interne Kontakt-ID (wird z. B. von `KontaktKomplettieren` verlangt) |
| `neuer-kontakt` | `true` = neuer Kontakt angelegt, `false` = an bestehenden gehängt. Kann in der Antwort fehlen — defensiv auswerten |
| `praefix-suchekontakte` | ob die Contact ID in einem Präfix-Bereich liegt. Kann ebenfalls fehlen |

## 3. Operation Assign (API: `AnfrageZuweisen`)

Weist die **Anfrage einem Bearbeiter** zu (Namensfalle: sie ordnet keine E-Mail einer Anfrage zu).

- **Assign To: Employee** → **Employee Email** ist die **externe Autohaus-Adresse** des Mitarbeiters, **nicht** dessen autocrm-Login. Sie muss auf genau **einen** Mitarbeiter passen, der für die Kombination Niederlassung + Kategorie gültiger Bearbeiter ist — sonst kommt `fehler_input:unbekannt:data.email`.
- **Assign To: Team** → Zuweisung an das **Bearbeiter-Team** gemäß Niederlassung/Kategorie. Achtung: Das ist eine echte Zuweisung, nicht „unverändert lassen".
- **Branch ID / Category leer** = Niederlassung bzw. Kategorie bleiben unverändert. Die Kategorie muss in der Ziel-Niederlassung existieren.
- Die Anfrage kann bei einem **vertretenden Mitarbeiter** landen.

## 4. Operation Attach Email (API: `AnfrageEmail`)

**Rein archivierend — es wird nichts versendet.** Der Versand läuft vorher über einen n8n-Mail-Node (z. B. Send Email/SMTP); diese Operation dokumentiert die Mail danach am Lead.

Zwei Eingabemodi:

- **Binary File** (Standard): eine `.eml`-Datei aus einem Binary-Feld, z. B. aus dem IMAP-Trigger („Download Attachments" bzw. RAW-Format) oder aus einem vorherigen Workflow-Schritt.
- **Raw EML Text**: der komplette RFC-822-Text (Header, Leerzeile, Body) als String — die Node kodiert selbst nach Base64. Nützlich nach dem Send-Email-Node, der keine fertige EML liefert: die Mail aus denselben Feldern per Expression nachbauen (Beispiel im Beispiel-Workflow).

Mindest-Header laut Spezifikation: `MIME-Version`, `Content-Type`, `From`, `To`, `Date`, `Subject`. S/MIME-verschlüsselte Mails kann autocrm nicht lesen. Maximal 50 MB (Base64-Größe); die Node prüft das vor dem Request.

## 5. Operation Add Note (API: `AnfrageNotiz`)

Hängt eine Notiz an den Verlauf, optional mit Dateianhängen aus Binary-Feldern.

- **Keep Status Unchanged**: Standardmäßig ändert eine neue Notiz den Status der Anfrage; mit diesem Schalter bleibt er unverändert.
- **Attachments**: je Eintrag ein Binary-Feld; der Dateiname kommt aus den Binary-Metadaten (überschreibbar per File Name, Pfadanteile werden entfernt). **Image Optimization** (Standard an) erlaubt autocrm, Bilder zu rekomprimieren.
- Größenlimit: 50 MB Base64 **pro Anhang und in Summe** — die Node prüft beides vor dem Request. Der MIME-Type wird serverseitig bestimmt.

## 6. Operation Exists (API: `AnfrageVorhanden`)

Prüft eine Lead-ID. Output:

- `existiert`: `1`/`0` (im Rahmen der Berechtigungen des API-Users).
- `weitergefuehrt-in`: Wurde die Anfrage durch **Zusammenführung** gelöscht, steht hier die ID der Nachfolge-Anfrage — so findet man umgehängte Leads wieder. Sonst `null`.

## 7. Durchsatz, Serialisierung, Retries

| Operation | Limit |
|---|---|
| Create | 3 / 60 s |
| Assign, Attach Email, Add Note | je 5 / 60 s |
| Exists | 150 / 60 s |

- Die Node **serialisiert** alle Aufrufe pro Credential innerhalb eines n8n-Prozesses (Serverregel: ein Request gleichzeitig). **Grenze:** Bei n8n im Queue-Mode mit mehreren Workern oder mehreren n8n-Instanzen greift diese Serialisierung nicht prozessübergreifend — dort fangen die automatischen Retries `fehler_parallel` ab. Empfehlung: ein API-User pro n8n-Installation, keine parallelen Massenläufe.
- **Automatische Retries:** Bei HTTP 429/503 bzw. `fehler_parallel`, `fehler_mengengeruest`, `fehler_tmp` versucht die Node den Aufruf bis zu **2-mal erneut** und respektiert dabei den `Retry-After`-Header (Wartezeit 1–30 s, ohne Header 5 s). `fehler_tmp` ist erwartbar — z. B. während in der Anfrage gerade telefoniert wird.
- Für Massenimporte den Workflow drosseln (Loop Over Items + Wait) — 3 Creates pro Minute sind das harte Limit.

## 8. Transport-Besonderheiten

- Die API antwortet im Normalfall mit **HTTP 308** auf eine andere Subdomain (z. B. `www2.autocrm.de`). Die Node folgt dem Redirect **selbst** und behält dabei Methode, Body und Authorization-Header — Standard-HTTP-Clients verlieren den Auth-Header bei so einem Host-Wechsel. Das Redirect-Ziel wird gemerkt und direkt angesprochen; fällt es aus, greift automatisch die Original-URL.
- Die Node nutzt natives `fetch` und damit **nicht** die n8n-Proxy-Einstellungen. Der n8n-Host braucht direkten HTTPS-Zugang zu `www.autocrm.de` **und** den Geschwister-Subdomains (`www2.` …).

## 9. Fehlermeldungen

| Status-Fehler | Bedeutung |
|---|---|
| `fehler_parallel` | Es lief bereits ein Request desselben API-Users (z. B. zweiter Worker) — Node hat schon automatisch neu versucht |
| `fehler_mengengeruest` | Durchsatzgrenze überschritten → Workflow drosseln |
| `fehler_tmp` | Temporär (z. B. Telefonat läuft in der Anfrage) → später erneut |
| `fehler_input:<detail>:<feld>` | Eingabefehler; z. B. `id_unbekannt:data.id-anfrage` = Lead-ID existiert nicht, `unbekannt:data.email` = keine eindeutige externe Mitarbeiter-Adresse für Niederlassung+Kategorie |
| `fehler_berechtigung` | API-User darf die Funktion nicht → Support |
| `fehler_wartungsarbeiten` | Wartungsfenster → später erneut |
| HTTP 401 | Zugangsdaten falsch (der Server antwortet hier mit HTML statt JSON — die Node fängt das ab) |

Erfolg heißt immer: HTTP 2xx **und** `status: "OK"` — die Node prüft beides.

## 10. Beispiel-Workflow

`examples/beispiel-workflow.json` importieren: Manual Trigger → Create → Assign, plus losgelöste Attach-Email- und Exists-Nodes mit Beispielwerten. **Achtung: Ausführen mit echten Credentials erzeugt einen echten Lead.** Vorher alle Platzhalter (`BRANCH_ID`, `CATEGORY`, `SOURCE_NAME`, E-Mail-Adressen) durch die Werte eures Mandanten ersetzen — die gültigen Werte nennt der autocrm-Support.
