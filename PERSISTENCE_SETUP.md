# Տվյալների durable պահեստի կարգավորում — քայլ առ քայլ 🇦🇲

Այս փաստաթուղթը նախատեսված է քեզ (GRM FLAP-ի սեփականատիրոջ) համար։ Նպատակը՝
**միայն մեկ անգամ** կարգավորել պահեստը, որից հետո ամեն անգամ կոդի մեջ ինչ-որ
նոր դետալ ավելացնելիս ու redeploy անելիս՝ խաղացողների բալանսը, ռեֆեռալները և
լիդերբորդի տվյալները **երբեք չկորչեն**։


## Ինչու է սա պետք

Railway/Render-ը (և ընդհանրապես ցանկացած deploy պլատֆորմ) ամեն redeploy-ի
ժամանակ սարքում է **նոր կոնտեյներ**։ Նոր կոնտեյների ներսի ֆայլերը սկսվում են
դատարկից — կոդը 100 անգամ փոխելիս դա նորմալ է, բայց եթե տվյալները պահված են
միայն կոնտեյների ներսում, ապա դրանք ջնջվում են ամեն deploy-ի հետ միասին։

Լուծումը՝ տվյալները պահել **կոդից/կոնտեյներից դուրս**։ Երկու անվճար տարբերակ կա՝
**(A) Upstash Redis** կամ **(B) Railway Volume `/data`**։ Բավական է դրանցից մեկը։


## Ինչպես ստուգել՝ արդյոք ամեն ինչ կարգին է

Կոդի մեջ ավելացրել եմ **իրական ստուգում**, որը պարզապես չի ենթադրում (որ env-ը
դրված է), այլ **իրականում գրում ու կարդում է** տվյալների բազայից և հետո ջնջում
փորձարկման գրառումը։ Դու ստանում ես «այո, տվյալները deploy-ին կդիմանան» կամ
«ոչ, դեռ վտանգավոր է» — հստակ պատասխան։

Ստուգելու 3 եղանակ.

### 1) Բացիր հասցեն բրաուզերում (ամենաարագը)

```
https://քո-դոմեյնը.com/internal/durability
```

- `"ok": true`  → տվյալները durable են, deploy-ը անվտանգ է։ ✅
- `"ok": false` → նայիր `probe.error` կամ `probe.warning`-ը — կասի ինչ պակասում է։ ❌

### 2) Հրաման տերմինալում

```bash
npm run check:durable
# կամ
node check-durability.js
# կամ ճշգրիտ JSON-ով (օգտակար սքրիպտների համար)
node check-durability.js --json
```

Վերադարձնում է 0 (անվտանգ) կամ 1 (վտանգավոր)։

### 3) Ադմինի health

```
https://քո-դոմեյնը.com/internal/health
```
ցույց է տալիս `persist.durable` ու `persist.backend`-ը (անվճար, առանց key-ի):


## Տարբերակ A — Upstash Redis (խորհուրդ եմ տալիս)

Տվյալները ապրում են Upstash-ի ամպի մեջ՝ բոլորովին կոդից դուրս։ Անվճար պլանը
բավական է։

1. Գրանցվիր [upstash.com](https://upstash.com) → «Create database» → ընտրիր
   ամենամոտ տարածաշրջանը → տես կհայտնվի `REST URL` և `REST Token`։
2. Դրանք ավելացրու deploy-ի Environment Variables-ում (Railway → Variables)՝

   ```
   UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
   UPSTASH_REDIS_REST_TOKEN=xxxxx
   ```

3. Redeploy արա ու ստուգիր `/internal/durability` → պետք է `"ok": true`։

> Խորհուրդ՝ առաջին deploy-ից առաջ նոր Redis-ը դատարկ է։ Առաջին անգամ բեռնելուց
> հետո ամեն ինչ ինքն իրեն պահպանվում է։


## Տարբերակ B — Railway Volume `/data`

Եթե չես ուզում արտաքին ծառայություն, Railway-ի **Volume**-ը մշտական սկավառակ է,
որը **դիմանում է redeploy-ին** (սկավառակը մնում է, փոխվում է միայն կոդը)։

1. Railway → քո Service-ը → **Settings → Volumes → Attach Volume**.
2. Mount Path դիր՝ **`/data`** (սա կարևոր է)։
3. Variable ավելացրու՝ `DATA_FILE=/data/store.json` (backup-ները ինքնաբերաբար
   կհայտնվեն `/data/backups/`-ում)։
4. Redeploy արա ու ստուգիր `/internal/durability` → `"ok": true`։


## Ինչ անել նոր դետալ ավելացնելուց ԱՌԱՋ (կարճ հիշեցում)

Որպեսզի լիովին հանգիստ լինես.

1. Բացիր ադմին → **Create backup now** (կամ `/internal/backups/create`)։
2. Խմբագրիր կոդը ու redeploy արա։
3. Ստուգիր `/internal/health` → `"ok": true` և `players` թիվը չի նվազել։
4. Ամեն լուրջ փոփոխությունից հետո մեկ անգամ `/internal/durability` → `"ok": true`։

Եթե ինչ-որ բան սխալ գնա → **Automatic backups**-ից Restore վերջին լավ snapshot-ը.
Ոչ մի խաղացող ոչինչ չի կորցնում։


## Ինչ է նշանակում «durable»-ի ստուգումը (տեխնիկապես)

Նախկինում կոդը durable-ը գուշակում էր միայն env-ից («Upstash URL կա՞», «ֆայլը
`/data`-ի տակ է՞»)։ Հիմա `GET /internal/durability`-ը և `npm run check:durable`-ը
կատարում են **իրական write → read → delete** փորձարկում, այնպես որ եթե token-ը
սխալ է, Redis-ը անհասանելի է կամ volume-ը read-only է — դու կտեսնես `"ok": false`,
այլ ոչ թե «կարծես կարգին է»։


## Խորհուրդ անմիջապես

Եթե տվյալները այս պահին **արդեն** պահվում են (օրինակ արդեն խաղացողներ կան),
ապա **նախ** կարգավորիր A կամ B-ն ու ստուգիր durability-ը, **հետո միայն** նոր
դետալ ավելացրու։ Այդպես ոչ մի վայրկյան էլ վտանգ չի լինի։


## Խնդիրների լուծում (Troubleshooting)

### «EISDIR … rename '/data/store.json.tmp' -> '/data/store.json'»

**Ախտանիշը.** `GET /internal/health`-ը ցույց է տալիս `"durable": true`, բայց
`"lastSaveError": "EISDIR: illegal operation on a directory, rename
'/data/store.json.tmp' -> '/data/store.json'"` (և հաճախ `"bytes": 4096`)։
Նոր deploy-ից հետո բալանսը / ռեֆեռալները / լիդերբորդը «ջնջվում» են։

**Պատճառը.** `/data/store.json`-ը **ֆայլ չէ, այլ թղթապանակ (directory)**։
Ինչպես է հայտնվել՝ տարբեր է (պատահական `mkdir`, ֆայլերի վերբեռնում/արխիվի
բացում volume-ի մեջ, նախկին փորձեր)։ Ատոմային պահպանումը
(`store.json.tmp` → վերանվանում → `store.json`) **ընդմիշտ ձախողվում է**,
որովհետև թղթապանակի վրա ֆայլ չի կարելի «վերանվանել»։ Խաղը շարունակում է
աշխատել հիշողությունից, իսկ ամեն 5 րոպեն մեկ ժամանակավոր ֆայլը գրվում է
կոնտեյների ներսը, որն **ոչնչանում է ամեն redeploy-ի ժամանակ**։ Ուստի ամեն
deploy տվյալները «ետ են գլորվում» մինչև վերջին ժամային backup-ը։

> Նոր ֆունկցիոնալություն ավելացնելը (օրինակ` index.html`-ի խմբագրումը)
> **ինքնին** ոչինչ չի ջնջում. ջնջումը տեղի է ունենում հենց redeploy-ի
> ժամանակ, երբ նոր կոնտեյները չի կարողանում կարդալ volume-ի «ֆայլը» և
> բեռնում է հին backup-ը։

**Ստուգիր Railway-ի shell-ում.**

```bash
ls -la /data            # /data/store.json տողը սկսվում է d-ով (drwxr-xr-x) => թղթապանակ է
```

**Ինչ անել.**

1. **Նախ** ներբեռնիր ընթացիկ վիճակը՝ ադմինից **Download backup**
   (կամ `curl -H "x-admin-key: <ADMIN_KEY>" https://քո-դոմեյնը.com/internal/backup -o flapy-backup.json`) —
   սա ամենաթարմ վիճակն է, որը կա միայն աշխատող կոնտեյների հիշողության մեջ։
2. Railway Service Shell-ում թղթապանակը մի կողմ դիր (ոչնչացնել պետք չէ).
   ```bash
   mv /data/store.json /data/store.json-old-dir
   ```
3. Redeploy արա նոր կոդը (այս ֆիքսով) և ստուգիր
   `GET /internal/health` → `"lastSaveError": null` և
   `GET /internal/durability` → `"ok": true`։ Կոդն այժմ boot-ի ժամանակ
   **ինքն է** ճանաչում ու մի կողմ է դնում նման թղթապանակը (լոգում գրում է,
   թե ուր է տեղափոխել), իսկ durability-ի ստուգումն այլևս **կարմիր է ցույց
   տալիս** այս խնդիրը։
4. Եթե backup-ի ֆայլի մեջ տվյալներն ավելի ամբողջական են, քան ավտոմատ
   backup-ները → վերականգնիր՝ ադմինում **Upload & restore**, կամ
   `POST /internal/backup`՝ վերևում ներբեռնած JSON-ով։
5. Համոզվիր, որ `/data/store.json-old-dir`-ի ներսում քեզ պետք եկող ոչինչ չկա
   (եթե դատարկ է՝ կարող ես ջնջել)։


### «Ֆիքսից հետո էլ /data/store.json-ը մնում է թղթապանակ (Mount Path-ի սխալ)»

**Ախտանիշը.** նախորդ ֆիքսը deploy արելուց հետո էլ `GET /internal/health`-ը շարունակում
է ցույց տալ `"dataFileIsDirectory": true` և `"players": 0`, իսկ լոգերում կա
`EISDIR`։ Ավելին՝ `mv /data/store.json …` հրամանը Railway shell-ում **ձախողվում է**
(`Device or resource busy` / `Invalid argument`), և կոդի ինքնաբուժումն էլ է գրում
`auto-rename FAILED`։

**Պատճառը.** թղթապանակը պատահական `mkdir` չէ — **Volume-ը մոնտաժված է հենց
`/data/store.json` հասցեում** (Railway-ում Volumes → Mount Path = `/data/store.json`)։
Մոնտաժման կետը (mount point) **միշտ թղթապանակ է** և երբեք չի կարող դառնալ ֆայլ,
իսկ վերանվանել էլ չի կարելի։ Ուստի ո՛չ `mv`-ն է օգնում, ո՛չ redeploy-ը — ամեն save
մնում է ձախողված, backup-ները չեն պահպանվում, և ամեն deploy-ից հետո
լիդերբորդը/բալանսը/ռեֆեռալները դատարկվում են։

Կոդն այժմ ճիշտ այս դեպքի համար տալիս է պատրաստի հուշում — նույն տեքստը երևում է
`/internal/health`-ի `dataFileHint` դաշտում, `/internal/durability`-ի `hint`
դաշտում, `npm run check:durable`-ի ելքում և ադմինի կարմիր զգուշացման մեջ:

**Որտեղ է գրված ճիշտ կարգավորումը (հուշումը).**

```text
On Railway this usually means the Volume is mounted DIRECTLY at /data/store.json
(a mount point can never become a file). Fix: Service → Settings → Volumes → set
the volume Mount Path to /data (NOT /data/store.json), keep the variable
DATA_FILE=/data/store.json, then redeploy.
```

**Ինչ անել (միակ ճիշտ լուծումը — Mount Path-ը փոխել).**

1. **Նախ** ներբեռնիր ընթացիկ վիճակը (ադմինից **Download backup** կամ
   `curl -H "x-admin-key: <ADMIN_KEY>" https://քո-դոմեյնը.com/internal/backup -o flapy-backup.json`),
   որովհետև ամենաթարմ տվյալները հիմա միայն աշխատող կոնտեյների հիշողության մեջ են։
2. Railway → քո Service → **Settings** → **Volumes**:
   * **Mount Path** դարձրու **`/data`** (ոչ `/data/store.json`):
   * Volume-ի չափը/անունը թող նույնը մնա։
3. **Variables** բաժնում **`DATA_FILE=/data/store.json` թող անփոփոխ մնա**
   (ֆայլի ճանապարհը ճիշտ է, սխալ է միայն մոնտաժման կետը)։ `BACKUP_DIR` չլինելու
   դեպքում backup-ները ինքնաբերաբար կգնան `/data/backups`։
4. **Redeploy** արա (Deploy → Redeploy / նոր commit): Նոր կոնտեյները volume-ը
   կտեսնի որպես **`/data` թղթապանակ**, իսկ `/data/store.json`-ը կդառնա սովորական
   ֆայլ, որի մեջ կարելի է գրել։
5. Ստուգիր.
   ```bash
   ls -la /data        # /data-ն է թղթապանակ, /data/store.json-ը՝ սովորական ֆայլ (-rw-…)
   ```
   * `GET /internal/health` → `"dataFileIsDirectory": false`, `"dataFileHint": null`,
     `"lastSaveError": null`, `"players": <ոչ զրո>`:
   * `GET /internal/durability` (կամ `npm run check:durable`) → `"ok": true`:
   * Ադմինում կարմիր զգուշացումը անհետանում է։
6. Եթե volume-ի մեջ պահպանվել էր հին տվյալ (`/data/store.json`-ի ներսում եղած
   ֆայլեր, կամ `/data/backups`), ու դրանք ավելի ամբողջական են — վերականգնիր
   ադմինում **Upload & restore**-ով կամ `POST /internal/backup`-ով։

> **Կարճ.** `Mount Path = /data` + `DATA_FILE = /data/store.json`։ Երբեք մի՛ դիր
> ֆայլի ամբողջական ճանապարհը Mount Path-ի մեջ։
