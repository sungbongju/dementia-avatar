/**
 * ================================================
 * InteractiveAvatar.tsx - 치매 예방 게임 AI 아바타
 * ================================================
 *
 * 🆕 변경사항: HeyGen STT → Web Speech API (브라우저 내장, 무료)
 *
 * 흐름:
 * 1. Web Speech API → 음성을 텍스트로 변환 (무료!)
 * 2. 최종 인식 결과 → route.ts 호출 → DB 조회 + 응답 생성
 * 3. avatar.interrupt() → HeyGen 자동 응답 차단 (유지)
 * 4. avatar.speak(REPEAT) → 응답 출력
 *
 * 핵심: 아바타가 말할 때 Web Speech 일시정지 → 자기 목소리 인식 방지
 * 
 * 🔧 2026-01-12 수정:
 * - 숫자 발음 문제 해결 (454 → "사백오십사")
 * - 이름 없을 때 "손님님" → "어서 오세요" 인사로 변경
 * 
 * 🔧 2026-01-20 수정:
 * - 게임 완료 시 격려 메시지 기능 추가 (GAME_COMPLETE)
 * ================================================
 */

import {
  AvatarQuality,
  StreamingEvents,
  VoiceEmotion,
  StartAvatarRequest,
  ElevenLabsModel,
  TaskType,
} from "@heygen/streaming-avatar";
import { useEffect, useRef, useState, useCallback } from "react";
import { useMemoizedFn, useUnmount } from "ahooks";

import { useStreamingAvatarSession } from "./logic/useStreamingAvatarSession";
import { StreamingAvatarProvider, StreamingAvatarSessionState } from "./logic";
import { AVATARS } from "@/app/lib/constants";
import { WebSpeechRecognizer } from "@/app/lib/webSpeechAPI";

// ============================================
// 🆕 숫자 → 한글 변환 유틸리티
// ============================================

/**
 * 숫자를 한글 발음으로 변환
 * 예: 454 → "사백오십사", 1000 → "천", 85 → "팔십오"
 */
function numberToKorean(num: number): string {
  if (num === 0) return '영';
  if (num < 0) return '마이너스 ' + numberToKorean(Math.abs(num));
  
  const units = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
  const smallUnits = ['', '십', '백', '천'];
  const bigUnits = ['', '만', '억', '조'];
  
  let result = '';
  const numStr = num.toString();
  const len = numStr.length;
  
  for (let i = 0; i < len; i++) {
    const digit = parseInt(numStr[i]);
    const pos = len - i - 1;
    const smallPos = pos % 4;
    const bigPos = Math.floor(pos / 4);
    
    if (digit !== 0) {
      // 1인 경우 '일'을 생략 (단, 일의 자리는 제외)
      if (digit === 1 && smallPos > 0) {
        result += smallUnits[smallPos];
      } else {
        result += units[digit] + smallUnits[smallPos];
      }
    }
    
    // 만, 억, 조 단위 추가
    if (smallPos === 0 && bigPos > 0) {
      const startIdx = Math.max(0, i - 3);
      const chunk = numStr.substring(startIdx, i + 1);
      if (parseInt(chunk) > 0) {
        result += bigUnits[bigPos];
      }
    }
  }
  
  return result || '영';
}

/**
 * 점수를 한글 텍스트로 변환
 * 예: 454 → "사백오십사점"
 */
function formatScoreToKorean(score: number | string): string {
  const numScore = typeof score === 'string' ? parseInt(score) : score;
  if (isNaN(numScore)) return '영점';
  return numberToKorean(numScore) + '점';
}

/**
 * 🆕 인사말 생성 함수
 * - 이름이 없으면 "손님님" 대신 일반적인 환영 인사
 * - 숫자는 한글로 변환
 */
function generateGreeting(
  name: string | undefined,
  stats: Record<string, unknown> | null
): string {
  const totalGames = stats?.total_games;
  const bestScore = stats?.best_score;
  
  // 이름이 없는 경우
  if (!name || name.trim() === '') {
    return '어서 오세요. 게임에 오신 것을 환영합니다. 저는 두뇌 게임 도우미예요.';
  }
  
  // 이름이 있고, 기존 플레이 기록이 있는 경우
  if (stats && totalGames && parseInt(String(totalGames)) > 0 && bestScore) {
    const scoreText = formatScoreToKorean(bestScore as number);
    return `안녕하세요, ${name}님! 다시 만나서 반가워요. 최고 점수가 ${scoreText}이네요!`;
  }
  
  // 이름이 있지만, 기록이 없는 경우
  return `안녕하세요, ${name}님! 저는 두뇌 게임 도우미예요.`;
}

// ============================================
// 🆕 게임 완료 격려 메시지 시스템
// ============================================

interface GameCompleteData {
  game: string;
  gameName: string;
  score: number;
  maxScore: number;
  playerName?: string;
  completedCount: number;
  totalGames: number;
}

/**
 * 격려 메시지 풀 - 점수대별, 상황별 다양한 메시지
 */
const ENCOURAGEMENT_MESSAGES = {
  // 높은 점수 (80점 이상)
  excellent: [
    "{name}님, {score} 정말 대단해요! 실력이 출중하시네요!",
    "와, {score}이에요! {name}님, 기억력이 정말 좋으시네요!",
    "{score}! 훌륭해요, {name}님! 이 조자로 계속 가봐요!",
    "{name}님, {score} 멋져요! 두뇌가 아주 건강하시네요!",
    "대단해요! {score}이라니, {name}님 최고예요!",
  ],
  // 중간 점수 (60-79점)
  good: [
    "{name}님, {score} 잘하셨어요! 꾸준히 하시면 더 좋아질 거예요.",
    "{score}! 좋은 결과예요, {name}님. 다음엔 더 잘할 수 있어요!",
    "잘하셨어요! {score}이면 충분히 좋은 점수예요, {name}님.",
    "{name}님, {score} 괜찮아요! 연습하면 점점 늘어요.",
    "좋아요, {name}님! {score} 훌륭한 시작이에요!",
  ],
  // 낮은 점수 (60점 미만) - 노력 칭찬
  effort: [
    "{name}님, 끝까지 완료하신 것만으로도 대단해요!",
    "포기하지 않고 끝까지 하신 {name}님, 멋져요!",
    "연습하면 늘어요! {name}님 화이팅!",
    "{name}님, 도전하는 자세가 아름다워요! 다음엔 더 잘할 거예요.",
    "잘하셨어요, {name}님! 꾸준히 하는 게 중요해요.",
  ],
  // 모든 게임 완료
  allComplete: [
    "와! {name}님, 오늘 모든 게임을 완료하셨어요! 대단해요! 기록을 저장해보세요.",
    "축하해요, {name}님! 여섯 개 게임 모두 완료! 저장 버튼을 눌러주세요.",
    "{name}님, 오늘의 두뇌 운동 완료! 정말 대단해요. 기록 저장하시는 거 잊지 마세요!",
  ],
  // 게임별 특화 메시지
  gameSpecific: {
    hwatu: [
      "기억력 게임을 잘 해내셨어요!",
      "짝을 찾는 실력이 좋으시네요!",
    ],
    yut: [
      "색상 패턴을 잘 기억하셨어요!",
      "집중력이 대단하시네요!",
    ],
    memory: [
      "숫자를 잘 기억하셨어요!",
      "기억력이 정말 좋으시네요!",
    ],
    proverb: [
      "속담을 잘 아시네요!",
      "언어 실력이 훌륭해요!",
    ],
    calc: [
      "계산을 잘 하셨어요!",
      "암산 실력이 좋으시네요!",
    ],
    sequence: [
      "순서를 잘 맞추셨어요!",
      "논리력이 뛰어나시네요!",
    ],
  },
};

/**
 * 게임 완료 격려 메시지 생성
 */
function generateEncouragement(data: GameCompleteData): string {
  const { game, score, maxScore, playerName, completedCount, totalGames } = data;
  const name = playerName || '회원';
  const scoreText = formatScoreToKorean(score);
  const percent = (score / maxScore) * 100;
  
  // 모든 게임 완료 시 - 특별 메시지
  if (completedCount >= totalGames) {
    const pool = ENCOURAGEMENT_MESSAGES.allComplete;
    const msg = pool[Math.floor(Math.random() * pool.length)];
    return msg.replace(/{name}/g, name).replace(/{score}/g, scoreText);
  }
  
  // 점수대별 메시지 선택
  let mainPool: string[];
  if (percent >= 80) {
    mainPool = ENCOURAGEMENT_MESSAGES.excellent;
  } else if (percent >= 60) {
    mainPool = ENCOURAGEMENT_MESSAGES.good;
  } else {
    mainPool = ENCOURAGEMENT_MESSAGES.effort;
  }
  
  // 메인 메시지 선택
  const mainMsg = mainPool[Math.floor(Math.random() * mainPool.length)]
    .replace(/{name}/g, name)
    .replace(/{score}/g, scoreText);
  
  // 50% 확률로 게임별 특화 메시지 추가
  const gamePool = ENCOURAGEMENT_MESSAGES.gameSpecific[game as keyof typeof ENCOURAGEMENT_MESSAGES.gameSpecific];
  if (gamePool && Math.random() < 0.5) {
    const gameMsg = gamePool[Math.floor(Math.random() * gamePool.length)];
    return `${mainMsg} ${gameMsg}`;
  }
  
  // 남은 게임 안내 (3개 이상 완료 시)
  if (completedCount >= 3 && completedCount < totalGames) {
    const remaining = totalGames - completedCount;
    return `${mainMsg} ${remaining}개만 더 하면 오늘의 두뇌 운동 완료예요!`;
  }
  
  return mainMsg;
}

// ============================================
// 아바타 설정
// ============================================
const AVATAR_CONFIG: StartAvatarRequest = {
  quality: AvatarQuality.Low,
  avatarName: AVATARS[0].avatar_id,
  voice: {
    rate: 1.2,                        // ✅ 쇼핑몰 봇과 동일
    emotion: VoiceEmotion.FRIENDLY,   // ✅ 쇼핑몰 봇과 동일
    model: ElevenLabsModel.eleven_flash_v2_5,
  },
  language: "ko",
};

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function InteractiveAvatar() {
  const {
    initAvatar,
    startAvatar,
    stopAvatar,
    sessionState,
    stream,
    avatarRef,
  } = useStreamingAvatarSession();

  // UI 상태
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isAvatarSpeaking, setIsAvatarSpeaking] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const mediaStream = useRef<HTMLVideoElement>(null);

  // 내부 상태 refs
  const isProcessingRef = useRef(false);
  const hasGreetedRef = useRef(false);
  const hasStartedRef = useRef(false);
  const userNameRef = useRef("");
  const userStatsRef = useRef<Record<string, unknown> | null>(null);

  // 🆕 Web Speech API ref
  const webSpeechRef = useRef<WebSpeechRecognizer | null>(null);
  const isAvatarSpeakingRef = useRef(false);

  // ============================================
  // API 호출
  // ============================================
  const fetchAccessToken = async () => {
    const response = await fetch("/api/get-access-token", { method: "POST" });
    const token = await response.text();
    console.log("Access Token:", token);

    return token;
  };

  const callChatAPI = async (type: string, data?: Record<string, unknown>) => {
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          userName: userNameRef.current,
          userStats: userStatsRef.current,
          ...data,
        }),
      });
      const result = await response.json();

      return result.reply || result.error || "응답을 생성하지 못했습니다.";
    } catch (error) {
      console.error("Chat API error:", error);

      return "죄송합니다. 오류가 발생했습니다.";
    }
  };

  // ============================================
  // 아바타 음성 출력 (Web Speech 일시정지 포함)
  // ============================================
  const speakWithAvatar = useCallback(
    async (text: string) => {
      if (!avatarRef.current || !text) return;

      try {
        console.log("🔇 Web Speech 일시정지");
        isAvatarSpeakingRef.current = true;
        setIsAvatarSpeaking(true);
        webSpeechRef.current?.pause();

        console.log("🗣️ Avatar speaking:", text);
        await avatarRef.current.speak({
          text,
          taskType: TaskType.REPEAT,
        });
      } catch (error) {
        console.error("Avatar speak error:", error);
        isAvatarSpeakingRef.current = false;
        setIsAvatarSpeaking(false);
        webSpeechRef.current?.resume();
      }
    },
    [avatarRef],
  );

  // ============================================
  // 🆕 사용자 음성 처리 (Web Speech API용)
  // ============================================
  const handleUserSpeech = useCallback(
    async (transcript: string) => {
      if (isAvatarSpeakingRef.current) {
        console.log("⏸️ 아바타가 말하는 중 - 무시:", transcript);

        return;
      }

      if (!transcript.trim() || isProcessingRef.current) return;

      isProcessingRef.current = true;
      setIsLoading(true);
      setInterimTranscript("");
      console.log("🎯 User said:", transcript);

      try {
        await avatarRef.current?.interrupt();
      } catch {
        // ignore
      }

      setChatHistory((prev) => {
        const newHistory = [
          ...prev,
          { role: "user" as const, content: transcript },
        ];

        callChatAPI("chat", {
          message: transcript,
          history: prev,
        }).then((reply) => {
          console.log("🎯 API reply:", reply);
          setChatHistory((current) => [
            ...current,
            { role: "assistant" as const, content: reply },
          ]);

          speakWithAvatar(reply);

          setIsLoading(false);
          isProcessingRef.current = false;
        });

        return newHistory;
      });
    },
    [avatarRef, speakWithAvatar],
  );

  // ============================================
  // 🆕 Web Speech API 초기화
  // ============================================
  const initWebSpeech = useCallback(() => {
    if (webSpeechRef.current) {
      console.log("🎤 Web Speech 이미 초기화됨");

      return;
    }

    if (!WebSpeechRecognizer.isSupported()) {
      console.error("🎤 Web Speech API 지원하지 않는 브라우저");
      alert(
        "이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Edge를 사용해주세요.",
      );

      return;
    }

    console.log("🎤 Web Speech API 초기화 중...");

    webSpeechRef.current = new WebSpeechRecognizer(
      {
        onResult: (transcript: string, isFinal: boolean) => {
          if (isAvatarSpeakingRef.current) {
            return;
          }

          if (isFinal) {
            console.log("🎤 최종 인식:", transcript);
            setInterimTranscript("");
            handleUserSpeech(transcript);
          } else {
            setInterimTranscript(transcript);
          }
        },

        onStart: () => {
          if (!isAvatarSpeakingRef.current) {
            setIsListening(true);
          }
        },

        onEnd: () => {
          setIsListening(false);
        },

        onSpeechStart: () => {
          if (!isAvatarSpeakingRef.current) {
            setIsListening(true);
          }
        },

        onSpeechEnd: () => {
          setTimeout(() => {
            if (!isAvatarSpeakingRef.current) {
              setIsListening(false);
            }
          }, 500);
        },

        onError: (error: string) => {
          console.error("🎤 Web Speech 에러:", error);
          if (error === "not-allowed") {
            alert(
              "마이크 권한이 필요합니다. 브라우저 설정에서 마이크를 허용해주세요.",
            );
          }
        },
      },
      {
        lang: "ko-KR",
        continuous: true,
        interimResults: true,
        autoRestart: true,
      },
    );

    console.log("🎤 Web Speech API 초기화 완료");
  }, [handleUserSpeech]);

  // ============================================
  // 🔧 세션 완전 초기화 함수
  // ============================================
  const resetSession = useMemoizedFn(async () => {
    console.log("🔄 세션 초기화 중...");

    if (webSpeechRef.current) {
      webSpeechRef.current.destroy();
      webSpeechRef.current = null;
    }

    try {
      await stopAvatar();
    } catch (e) {
      console.log("stopAvatar 에러 (무시):", e);
    }

    hasStartedRef.current = false;
    hasGreetedRef.current = false;
    isProcessingRef.current = false;
    isAvatarSpeakingRef.current = false;
    userNameRef.current = "";
    userStatsRef.current = null;
    setChatHistory([]);
    setIsLoading(false);
    setIsListening(false);
    setIsAvatarSpeaking(false);
    setInterimTranscript("");

    await new Promise((r) => setTimeout(r, 500));
    console.log("🔄 세션 초기화 완료");
  });

  // ============================================
  // 세션 시작
  // ============================================
  const startSession = useMemoizedFn(async () => {
    if (hasStartedRef.current) {
      console.log("⚠️ 이미 세션 시작됨, 무시");

      return;
    }
    hasStartedRef.current = true;

    try {
      const token = await fetchAccessToken();
      const avatar = initAvatar(token);

      avatar.on(StreamingEvents.STREAM_READY, async (event) => {
        console.log("Stream ready:", event.detail);

        if (!hasGreetedRef.current) {
          await new Promise((r) => setTimeout(r, 1500));

          // 🆕 수정: "손님" 기본값 제거, generateGreeting 함수 사용
          const name = userNameRef.current;  // 기본값 없음!
          const stats = userStatsRef.current as Record<string, unknown> | null;

          // 🆕 새로운 인사말 생성 함수 사용 (숫자 한글 변환 + 이름 없을 때 처리)
          const greeting = generateGreeting(name, stats);

          console.log("👋 인사말:", greeting);
          await speakWithAvatar(greeting);
          setChatHistory([{ role: "assistant", content: greeting }]);
          hasGreetedRef.current = true;
        }
      });

      avatar.on(StreamingEvents.STREAM_DISCONNECTED, () => {
        console.log("Stream disconnected");
        hasGreetedRef.current = false;
        hasStartedRef.current = false;

        webSpeechRef.current?.destroy();
        webSpeechRef.current = null;
      });

      avatar.on(StreamingEvents.AVATAR_START_TALKING, () => {
        console.log("🗣️ Avatar started talking - Web Speech 일시정지");
        isAvatarSpeakingRef.current = true;
        setIsAvatarSpeaking(true);
        webSpeechRef.current?.pause();
      });

      avatar.on(StreamingEvents.AVATAR_STOP_TALKING, async () => {
        console.log("🔈 Avatar stopped talking - Web Speech 재개");
        isAvatarSpeakingRef.current = false;
        setIsAvatarSpeaking(false);

        await new Promise((r) => setTimeout(r, 500));
        webSpeechRef.current?.resume();
        console.log("🎤 Web Speech 재개 완료");
      });

      await startAvatar(AVATAR_CONFIG);

      console.log("🎤 Web Speech API 시작...");
      initWebSpeech();

      setTimeout(() => {
        webSpeechRef.current?.start();
        console.log("🎤 Web Speech 인식 시작");
      }, 2000);
    } catch (error) {
      console.error("Session error:", error);
      hasStartedRef.current = false;
    }
  });

  // ============================================
  // 텍스트 메시지 전송
  // ============================================
  const handleSendMessage = useMemoizedFn(async () => {
    const text = inputText.trim();
    if (!text || !avatarRef.current || isLoading) return;

    setInputText("");
    setIsLoading(true);

    const newHistory = [
      ...chatHistory,
      { role: "user" as const, content: text },
    ];

    setChatHistory(newHistory);

    const reply = await callChatAPI("chat", {
      message: text,
      history: chatHistory,
    });

    setChatHistory([
      ...newHistory,
      { role: "assistant" as const, content: reply },
    ]);

    await speakWithAvatar(reply);
    setIsLoading(false);
  });

  // ============================================
  // 🆕 마이크 토글 버튼 핸들러
  // ============================================
  const toggleMicrophone = useCallback(() => {
    if (!webSpeechRef.current) {
      initWebSpeech();
      // initWebSpeech 후 start는 setTimeout으로 처리
      setTimeout(() => {
        webSpeechRef.current?.start();
      }, 100);

      return;
    }

    if (webSpeechRef.current.getIsPaused()) {
      webSpeechRef.current.resume();
    } else {
      webSpeechRef.current.pause();
    }
  }, [initWebSpeech]);

  // ============================================
  // postMessage 통신 (게임 페이지와)
  // ============================================
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const { type, name, stats, game } = event.data || {};

      switch (type) {
        case "RESET_AVATAR":
        case "STOP_AVATAR":
          console.log(`📥 ${type}`);
          await resetSession();
          break;

        case "START_AVATAR":
          console.log("📥 START_AVATAR", { name, stats });

          await resetSession();

          if (name) userNameRef.current = name;
          if (stats) userStatsRef.current = stats;

          startSession();
          break;

        case "EXPLAIN_GAME":
          console.log("📥 EXPLAIN_GAME:", game);
          if (avatarRef.current && game) {
            const explanation = await callChatAPI("game_explain", { game });

            speakWithAvatar(explanation);
          }
          break;

        // 🆕 게임 완료 시 격려 메시지
        case "GAME_COMPLETE":
          console.log("📥 GAME_COMPLETE:", event.data);
          if (avatarRef.current) {
            const gameData: GameCompleteData = {
              game: event.data.game,
              gameName: event.data.gameName,
              score: event.data.score,
              maxScore: event.data.maxScore,
              playerName: event.data.playerName || userNameRef.current,
              completedCount: event.data.completedCount,
              totalGames: event.data.totalGames,
            };
            
            const encouragement = generateEncouragement(gameData);
            console.log("🎉 격려 메시지:", encouragement);
            
            // 채팅 히스토리에 추가
            setChatHistory((prev) => [
              ...prev,
              { role: "assistant" as const, content: encouragement },
            ]);
            
            speakWithAvatar(encouragement);
          }
          break;
      }
    };

    window.addEventListener("message", handleMessage);

    return () => window.removeEventListener("message", handleMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 언마운트 시 정리
  useUnmount(() => {
    webSpeechRef.current?.destroy();

    try {
      stopAvatar();
    } catch {
      // ignore
    }
  });

  // 비디오 스트림 연결
  useEffect(() => {
    if (stream && mediaStream.current) {
      mediaStream.current.srcObject = stream;
      mediaStream.current.onloadedmetadata = () => mediaStream.current?.play();
    }
  }, [stream]);

  // ============================================
  // UI
  // ============================================
  const getStatusText = () => {
    if (isAvatarSpeaking) return "말하는 중...";
    if (isListening) return "듣는 중...";
    if (isLoading) return "생각 중...";

    return "말씀하세요";
  };

  const getStatusColor = () => {
    if (isAvatarSpeaking) return "bg-blue-500";
    if (isListening) return "bg-red-500 animate-pulse";
    if (isLoading) return "bg-yellow-500";

    return "bg-green-500";
  };

  return (
    <div className="w-full h-full flex flex-col">
      {sessionState === StreamingAvatarSessionState.CONNECTED && stream ? (
        <div className="flex-1 relative flex flex-col">
          <div className="relative flex-shrink-0">
            <video
              ref={mediaStream}
              autoPlay
              playsInline
              style={{ display: "block", width: "100%", height: "auto" }}
            />

            {/* 종료 버튼 */}
            <button
              className="absolute top-2 right-2 w-7 h-7 bg-black/50 hover:bg-red-600 text-white rounded-full flex items-center justify-center text-xs"
              onClick={() => resetSession()}
            >
              ✕
            </button>

            {/* 🆕 마이크 토글 버튼 */}
            <button
              className={`absolute top-2 left-2 w-7 h-7 ${
                isListening
                  ? "bg-red-500 animate-pulse"
                  : "bg-black/50 hover:bg-green-600"
              } text-white rounded-full flex items-center justify-center text-sm`}
              disabled={isAvatarSpeaking}
              title={isListening ? "마이크 끄기" : "마이크 켜기"}
              onClick={toggleMicrophone}
            >
              {isListening ? "🎤" : "🎙️"}
            </button>

            {/* 상태 표시 */}
            <div className="absolute bottom-2 left-2 flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${getStatusColor()}`} />
              <span className="text-white text-xs bg-black/50 px-2 py-1 rounded">
                {getStatusText()}
              </span>
            </div>

            {/* 🆕 중간 인식 결과 표시 */}
            {interimTranscript && (
              <div className="absolute bottom-10 left-2 right-2">
                <div className="bg-black/70 text-white text-xs px-2 py-1 rounded">
                  🎤 &quot;{interimTranscript}&quot;
                </div>
              </div>
            )}
          </div>

          {/* 텍스트 입력 */}
          <div className="p-2 bg-zinc-800 border-t border-zinc-700">
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 bg-zinc-700 text-white text-sm rounded-lg border border-zinc-600 focus:outline-none focus:border-purple-500 disabled:opacity-50"
                disabled={isLoading || isAvatarSpeaking}
                placeholder="텍스트로 질문하세요..."
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && !e.shiftKey && handleSendMessage()
                }
              />
              <button
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-zinc-600 text-white text-sm rounded-lg"
                disabled={isLoading || isAvatarSpeaking || !inputText.trim()}
                onClick={handleSendMessage}
              >
                {isLoading ? "..." : "전송"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          {sessionState === StreamingAvatarSessionState.CONNECTING ? (
            <div className="flex flex-col items-center gap-3 text-white">
              <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">연결 중...</span>
            </div>
          ) : (
            <button
              className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-full text-base font-medium shadow-lg"
              onClick={startSession}
            >
              🎮 게임 도우미 시작
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function InteractiveAvatarWrapper() {
  return (
    <StreamingAvatarProvider basePath={process.env.NEXT_PUBLIC_BASE_API_URL}>
      <InteractiveAvatar />
    </StreamingAvatarProvider>
  );
}
