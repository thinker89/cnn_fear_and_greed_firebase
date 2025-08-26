// functions/src/index.ts
import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------
const REGION = "asia-northeast3"; // 서울
const CNN_URL =
  "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
const BACKUP_URL =
  "https://thinker89.github.io/docs_hub/project_market_mood/api/cnn_api.json";

// CNN / 백업 공통 응답 형태
type CnnShape = {
  fear_and_greed?: { score?: number; rating?: string; timestamp?: string };
};

// ---------------------------------------------------------------------------
// 내부 유틸
// ---------------------------------------------------------------------------

// Node 20의 fetch에 타임아웃을 주기 위한 헬퍼
async function fetchWithTimeout(input: string, init: RequestInit, ms = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ac.signal as any });
  } finally {
    clearTimeout(t);
  }
}

// Android와 동일한 느낌의 위장 헤더
const SPOOF_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 13; FnGApp)",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
  "Cache-Control": "no-cache",
};

async function fetchJsonWithHeaders(url: string): Promise<CnnShape> {
  const res = await fetchWithTimeout(
    url,
    { method: "GET", headers: SPOOF_HEADERS },
    12000
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  // CNN이 가끔 텍스트/기이한 인코딩을 줄 수 있어 방어적으로 처리
  try {
    return (await res.json()) as CnnShape;
  } catch {
    const txt = await res.text();
    return JSON.parse(txt) as CnnShape;
  }
}

// 실제 작업을 수행하는 공통 코어 (스케줄/수동 둘 다 여기 호출)
async function fetchAndBroadcastCore() {
  let score: number | undefined;
  let timestamp: string | undefined;
  let source: "cnn" | "github" = "cnn";

  try {
    // 1) CNN 시도 (위장 헤더)
    const j = await fetchJsonWithHeaders(CNN_URL);
    score = j?.fear_and_greed?.score;
    timestamp = j?.fear_and_greed?.timestamp;
    if (typeof score !== "number" || !timestamp) {
      throw new Error("CNN payload missing fields");
    }
  } catch (e: any) {
    console.warn(
      "[FNG] CNN fetch failed, fallback to GitHub:",
      e?.message ?? e
    );
    // 2) GitHub 백업
    const j2 = await fetchJsonWithHeaders(BACKUP_URL);
    score = j2?.fear_and_greed?.score;
    timestamp = j2?.fear_and_greed?.timestamp;
    source = "github";
    if (typeof score !== "number" || !timestamp) {
      throw new Error("Backup payload missing fields");
    }
  }

  // 3) Firestore 문서 1개 덮어쓰기 (fng/latest)
  await db
    .collection("fng")
    .doc("latest")
    .set(
      {
        score,
        timestamp, // 원문 UTC 문자열 그대로 보관
        source,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  // 4) FCM data-only 팬아웃 (토픽: fng-all)
  await messaging.send({
    topic: "fng-all",
    data: {
      score: String(score),
      timestamp: String(timestamp),
      source,
    },
    android: { priority: "high" },
    apns: {
      headers: { "apns-push-type": "background", "apns-priority": "5" },
      payload: { aps: { "content-available": 1 } },
    },
  });

  console.log("[FNG] updated & broadcast", { score, timestamp, source });
  return { score, timestamp, source };
}

// ---------------------------------------------------------------------------
// 1) 스케줄 트리거: KST 매시 55분
// ---------------------------------------------------------------------------
export const fetchAndBroadcastFNG = functions
  .region(REGION)
  .pubsub.schedule("55 * * * *")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    await fetchAndBroadcastCore();
    return null;
  });

// ---------------------------------------------------------------------------
// 2) 수동 실행용 HTTP 엔드포인트 (콘솔 Run / 브라우저/터미널 호출)
//    GET/POST 모두 허용, JSON 결과 반환
// ---------------------------------------------------------------------------
export const fetchAndBroadcastFNG_manual = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    try {
      // 간단한 보호: GET/POST 외 차단
      if (req.method !== "GET" && req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
      }
      const result = await fetchAndBroadcastCore();
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.status(200).send(JSON.stringify({ ok: true, ...result }));
    } catch (e: any) {
      console.error("[FNG manual] error:", e?.message ?? e);
      res
        .status(500)
        .send(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    }
  });
