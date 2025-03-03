const OpenAI = require("openai");
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());
require("dotenv").config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

console.log(
    "TMDB_BEARER_TOKEN Loaded:",
    TMDB_API_KEY ? "Yes" : "No, check .env"
);

// TMDB API 전용 axios 인스턴스 생성 (language: 'en-US' 추가)
const tmdbApi = axios.create({
    baseURL: "https://api.themoviedb.org/3",
    headers: {
        Accept: "application/json",
        Authorization: `Bearer ${TMDB_API_KEY}`,
    },
    params: {
        language: "en-US", // 영어로 결과를 받도록 설정
    },
});

app.post("/recommend", async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) {
            return res.status(400).json({ error: "메시지를 입력해주세요" });
        }

        console.log("OpenAI 요청 시작:", message);
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content:
                        '당신은 영화,TV시리즈 추천 전문가입니다. 사용자가 요청하면 요청에 대한 간단한 소개 문장과 작품 제목 3개를 JSON 형식으로 추천해주세요. 가능하면 TMDB 영화 ID도 함께 제공하세요. 예: { "intro": "다음 슬픈 사랑 영화 추천입니다:", "movies": [{"title": "인터스텔라", "id": 157336}, {"title": "글래디에이터", "id": 98}, {"title": "트로이", "id": 65291}] }',
                },
                { role: "user", content: `${message} 추천해줘` },
            ],
            max_tokens: 150,
        });

        const rawResponse = completion.choices[0].message.content.trim();
        let intro = "";
        const movies = [];

        // OpenAI 응답 파싱
        if (rawResponse.startsWith("{") && rawResponse.endsWith("}")) {
            const parsed = JSON.parse(rawResponse);
            intro = parsed.intro || "";
            movies.push(
                ...(parsed.movies || []).filter(
                    (movie) => movie.title && movie.title.trim()
                )
            );
        } else {
            // JSON 형식이 아닐 경우 라인 단위로 파싱
            const lines = rawResponse
                .split("\n")
                .filter((line) => line.trim())
                .map((line) => line.trim());
            intro = lines[0] || `다음은 ${message} 추천입니다:`;
            lines.slice(1).forEach((line) => {
                const titleMatch = line.match(/["']([^"']+)["']/i);
                const title = titleMatch
                    ? titleMatch[1].trim()
                    : line.trim().split("**")[1] || line.trim();
                if (title) movies.push({ title, id: null });
            });
        }

        // TMDB 정보 보강
        // (기존에 번역용 OpenAI 호출이 있었다면 제거 또는 주석 처리)
        const enrichedMovies = await Promise.all(
            movies.slice(0, 3).map(async (movie) => {
                try {
                    // 1) ID가 이미 있다면 TMDB detail로 바로 조회
                    if (movie.id) {
                        const tmdbDetailResponse = await tmdbApi.get(
                            `/movie/${movie.id}`
                        );
                        const result = tmdbDetailResponse.data;

                        // 한국 작품인지 체크
                        const isKorean = result.original_language === "ko";

                        // title(영화) vs name(TV) 처리. 여기서는 영화만 가정.
                        const finalTitle = isKorean
                            ? movie.title // 한국어 작품이면 원래 제목 그대로
                            : result.title; // 그 외에는 영어 타이틀

                        return {
                            title: finalTitle,
                            koreanTitle: isKorean ? movie.title : null,
                            id: result.id,
                            poster_path: result.poster_path,
                            overview: result.overview,
                        };
                    } else {
                        // 2) ID가 없으면 검색
                        const tmdbSearchResponse = await tmdbApi.get(
                            "/search/multi",
                            {
                                params: {
                                    query: movie.title, // 이미 한국어 or 기타 언어, en-US로 검색
                                },
                            }
                        );

                        const result = tmdbSearchResponse.data.results[0];
                        if (result) {
                            // TV 시리즈인지 영화인지 구분
                            const mediaType = result.media_type; // 'movie' | 'tv' | 'person' ...
                            const isKorean = result.original_language === "ko";

                            let finalTitle = "";
                            if (mediaType === "tv") {
                                finalTitle = isKorean
                                    ? movie.title
                                    : result.name;
                            } else if (mediaType === "movie") {
                                finalTitle = isKorean
                                    ? movie.title
                                    : result.title;
                            } else {
                                // 그 외에는 movie.title 그대로 사용하거나 적절히 처리
                                finalTitle = isKorean
                                    ? movie.title
                                    : result.name || result.title;
                            }

                            return {
                                title: finalTitle,
                                koreanTitle: isKorean ? movie.title : null,
                                id: result.id,
                                poster_path: result.poster_path,
                                overview: result.overview,
                            };
                        }
                        // 검색 결과가 없으면 원래 제목만 반환
                        return { title: movie.title, id: null };
                    }
                } catch (tmdbError) {
                    console.error(
                        `TMDB API 오류 (${movie.title}):`,
                        tmdbError.response?.status,
                        tmdbError.message
                    );
                    return { title: movie.title, id: null };
                }
            })
        );

        console.log("추출된 소개 문장:", intro);
        console.log("추출된 영화 목록:", enrichedMovies);
        res.status(200).json({ intro, movies: enrichedMovies });
    } catch (error) {
        console.error("API 요청 실패:", error);
        res.status(400).json({
            error: "API 요청 실패",
            rawError: error.message,
        });
    }
});

const PORT = process.env.PORT || 4040;
app.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
