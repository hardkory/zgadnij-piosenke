import React, { useState, useRef, useEffect } from "react";
import { Music2, Check, X, Trash2, RotateCcw, Play, Loader2, Settings, SkipForward, ChevronLeft } from "lucide-react";
import { DEFAULT_TRACK_URLS } from "./defaultTracks.js";

// Normalizacja tekstu odgadywanego tytułu, żeby porównanie było odporne na duże litery,
// polskie znaki i znaki interpunkcyjne. Przykład: "Bóle serca" i "bole serca" są traktowane tak samo.
function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Wersja do podpowiedzi: nie usuwa spacji, więc podpowiedzi działają bardziej naturalnie
// np. wpisanie "kama" znajdzie "Kamil Bednarek" bez potrzeby dokładnego dopasowania.
function normalizeForSearch(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Wyciąga ID utworu z linku Spotify, żeby można było pobrać jego metadane i embed player.
function extractSpotifyId(url) {
  if (!url) return null;
  const m = url.match(/track[/:]([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

const MAX_ATTEMPTS = 5;
const MAX_LOOPS = 1; // ile razy fragment ma zagrać na jedno kliknięcie play
const LIBRARY_KEY = "zgadnij-piosenke-library-v1";
const RANKING_KEY = "zgadnij-piosenke-ranking-v1";
const INVALID_DEFAULT_TRACK_IDS = new Set([
  "7qiZfU4dY1lWllzX7mPBDT",
  "1zi7xx7UVEFkmKfvGQ3nQ8",
  "4fouWK6XVHhj7G1ZbJQq1q",
]);

// Mapa poziomów trudności:
// zielony = łatwy, żółty = średni, pomarańczowy = trudny,
// czerwony = ekspert, fioletowy = niemożliwy.
const DIFFICULTIES = [
  { id: "easy", label: "Łatwy", color: "#2ED573", seconds: [3, 6, 10, 15, 20] },
  { id: "medium", label: "Średni", color: "#B8A324", seconds: [1, 2, 4, 7, 12] },
  { id: "hard", label: "Trudny", color: "#D9822B", seconds: [1, 2, 3, 5, 8] },
  { id: "expert", label: "Ekspert", color: "#D9483C", seconds: [1, 1.5, 2, 3, 5] },
  { id: "impossible", label: "Niemożliwy", color: "#A855F7", seconds: [0.5, 1, 1.5, 2, 3] },
];

function unlockedSeconds(difficulty, attemptNumber) {
  const idx = Math.min(Math.max(attemptNumber - 1, 0), difficulty.seconds.length - 1);
  return difficulty.seconds[idx];
}

// Ładuje oficjalne Spotify iFrame API raz na całą sesję
let spotifyApiPromise = null;
function loadSpotifyIframeApi() {
  if (spotifyApiPromise) return spotifyApiPromise;
  spotifyApiPromise = new Promise((resolve) => {
    if (window.__spotifyIframeApi) {
      resolve(window.__spotifyIframeApi);
      return;
    }
    window.onSpotifyIframeApiReady = (IFrameAPI) => {
      window.__spotifyIframeApi = IFrameAPI;
      resolve(IFrameAPI);
    };
    if (!document.getElementById("spotify-iframe-api-script")) {
      const script = document.createElement("script");
      script.id = "spotify-iframe-api-script";
      script.src = "https://open.spotify.com/embed/iframe-api/v1";
      script.async = true;
      document.body.appendChild(script);
    }
  });
  return spotifyApiPromise;
}

// Publiczny endpoint Spotify oEmbed — pobiera tytuł i okładkę tylko z linku
async function fetchTrackMeta(trackId) {
  const pageUrl = `https://open.spotify.com/track/${trackId}`;
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(pageUrl)}`);
  if (!res.ok) throw new Error("oembed request failed");
  const data = await res.json();
  return { title: (data.title || "").trim(), thumbnail: data.thumbnail_url || null };
}

export default function GuessableGame() {
  // Stan gry: ekrany setup, play i finished odpowiadają za przejście między ekranami.
  const [screen, setScreen] = useState("setup"); // setup | play | finished
  // Lista utworów w bibliotece. Każdy element ma ID, link, tytuł, okładkę, stan pobierania i czy jest wybrany do gry.
  const [songs, setSongs] = useState([]); // {trackId, spotifyUrl, title, thumbnail, status, selected}
  const [bulkText, setBulkText] = useState("");
  const [difficultyId, setDifficultyId] = useState("medium");
  const [playlist, setPlaylist] = useState([]);
  const [order, setOrder] = useState([]);
  const [songIndex, setSongIndex] = useState(0);
  const [attempt, setAttempt] = useState(1);
  const [guess, setGuess] = useState("");
  const [status, setStatus] = useState(null); // null | "correct" | "wrong" | "revealed"
  const [log, setLog] = useState([]); // {type: 'wrong'|'skip', text}
  const [score, setScore] = useState(0);
  const [roundResults, setRoundResults] = useState([]);
  const [ranking, setRanking] = useState([]);

  const difficulty = DIFFICULTIES.find((d) => d.id === difficultyId);
  const currentSong = order.length ? playlist[order[songIndex]] : null;

  // Po załadowaniu komponentu pobieramy wcześniej zapisane utwory z localStorage
  // i uzupełniamy brakujące piosenki z domyślnej listy DEFAULT_TRACK_URLS.
  useEffect(() => {
    let loaded = [];
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) loaded = parsed.filter((song) => !INVALID_DEFAULT_TRACK_IDS.has(song.trackId));
      }
    } catch (e) {
      // ignoruj błędy odczytu
    }
    if (loaded.length) setSongs(loaded);

    const existingIds = new Set(loaded.map((s) => s.trackId));
    const missing = DEFAULT_TRACK_URLS.filter((url) => {
      const id = extractSpotifyId(url);
      return id && !existingIds.has(id);
    });
    if (missing.length) addTracksFromLines(missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Każda zmiana biblioteki jest automatycznie zapisywana w localStorage,
  // dzięki czemu użytkownik nie traci swoich utworów po odświeżeniu strony.
  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(songs));
    } catch (e) {
      // ignoruj błędy zapisu (np. brak miejsca)
    }
  }, [songs]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RANKING_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setRanking(parsed);
      }
    } catch (e) {
      // ignoruj błędy odczytu rankingu
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(RANKING_KEY, JSON.stringify(ranking));
    } catch (e) {
      // ignoruj błędy zapisu rankingu
    }
  }, [ranking]);

  // Dodaje utwory z listy linków. Dla każdego linku pobiera ID i zapisuje wpis w stanie.
  // Następnie od razu próbuje pobrać metadane (tytuł i okładkę) z API Spotify oEmbed.
  function addTracksFromLines(lines) {
    setSongs((prevSongs) => {
      const existingIds = new Set(prevSongs.map((s) => s.trackId));
      const newEntries = [];
      for (const line of lines) {
        const trackId = extractSpotifyId(line);
        if (!trackId || existingIds.has(trackId)) continue;
        existingIds.add(trackId);
        newEntries.push({ trackId, spotifyUrl: line, title: "", artist: "", thumbnail: null, status: "pending", selected: true });
      }
      if (!newEntries.length) return prevSongs;

      newEntries.forEach((entry) => {
        fetchTrackMeta(entry.trackId)
          .then(({ title, thumbnail }) => {
            setSongs((prev) =>
              prev.map((s) =>
                s.trackId === entry.trackId ? { ...s, title, thumbnail, status: title ? "ready" : "error" } : s
              )
            );
          })
          .catch(() => {
            setSongs((prev) => prev.map((s) => (s.trackId === entry.trackId ? { ...s, status: "error" } : s)));
          });
      });

      return [...prevSongs, ...newEntries];
    });
  }

  function addFromBulk() {
    const lines = bulkText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    addTracksFromLines(lines);
    setBulkText("");
  }

  function updateManualTitle(trackId, title) {
    setSongs((prev) =>
      prev.map((s) => (s.trackId === trackId ? { ...s, title, status: title.trim() ? "ready" : "error" } : s))
    );
  }

  function updateManualArtist(trackId, artist) {
    setSongs((prev) => prev.map((s) => (s.trackId === trackId ? { ...s, artist } : s)));
  }

  function removeSong(trackId) {
    setSongs((prev) => prev.filter((s) => s.trackId !== trackId));
  }

  function toggleSelected(trackId) {
    setSongs((prev) =>
      prev.map((s) => (s.trackId === trackId ? { ...s, selected: !(s.selected !== false) } : s))
    );
  }

  function selectAll(flag) {
    setSongs((prev) => prev.map((s) => ({ ...s, selected: flag })));
  }

  // Rozpoczyna rozgrywkę: wybiera tylko gotowe, zaznaczone utwory,
  // miesza kolejność i ustawia pierwszy stan rundy.
  function startGame() {
    const ready = songs.filter((s) => s.status === "ready" && s.title.trim() && s.selected !== false);
    if (!ready.length) return;
    setPlaylist(ready);
    const shuffled = ready.map((_, i) => i).sort(() => Math.random() - 0.5);
    setOrder(shuffled);
    setSongIndex(0);
    setAttempt(1);
    setGuess("");
    setStatus(null);
    setLog([]);
    setScore(0);
    setRoundResults([]);
    setScreen("play");
  }

  // Sprawdza odpowiedź gracza. Jeśli zgadł, dodaje punkty do wyniku,
  // jeśli nie — zapisuje błędną odpowiedź i przechodzi do kolejnej próby lub odsłonięcia utworu.
  function submitGuess() {
    if (!guess.trim() || status === "correct" || status === "revealed") return;
    const correct = normalize(guess) === normalize(currentSong.title);
    if (correct) {
      const points = MAX_ATTEMPTS - attempt + 1;
      setScore((s) => s + points);
      setStatus("correct");
      setRoundResults((r) => [...r, { title: currentSong.title, points }]);
    } else {
      setLog((prev) => [...prev, { type: "wrong", text: guess }]);
      setGuess("");
      advanceOrReveal();
    }
  }

  // Pomija próbę bez podawania odpowiedzi. To działa jak „przegranie” tej próby,
  // ale bez wpisywania niepoprawnej nazwy do logu.
  function skipAttempt() {
    if (status === "correct" || status === "revealed") return;
    setLog((prev) => [...prev, { type: "skip", text: "" }]);
    advanceOrReveal();
  }

  // Jeżeli skończyły się próby, odsłania utwór i kończy rundę.
  // W przeciwnym razie tylko odświeża stan na kolejny ruch.
  function advanceOrReveal() {
    if (attempt >= MAX_ATTEMPTS) {
      setStatus("revealed");
      setRoundResults((r) => [...r, { title: currentSong.title, points: 0 }]);
    } else {
      setStatus("wrong");
      setTimeout(() => setStatus(null), 450);
      setAttempt((a) => Math.min(a + 1, MAX_ATTEMPTS));
    }
  }

  // Przechodzi do następnej piosenki w tej samej sesji.
  // Gdy nie ma już kolejnych utworów, zapisuje wynik do rankingu i pokazuje ekran końcowy.
  function nextSong() {
    if (songIndex + 1 >= order.length) {
      const entries = roundResults.map((item) => ({
        title: item.title,
        points: item.points,
        difficulty: difficulty.label,
        date: new Date().toLocaleDateString("pl-PL"),
      }));
      setRanking((prev) => [...prev, ...entries].sort((a, b) => b.points - a.points).slice(0, 10));
      setScreen("finished");
      return;
    }
    setSongIndex((i) => i + 1);
    setAttempt(1);
    setGuess("");
    setStatus(null);
    setLog([]);
  }

  return (
    <div style={styles.page}>
      <style>{fontImport}</style>

      {screen === "setup" && (
        <SetupScreen
          songs={songs}
          bulkText={bulkText}
          setBulkText={setBulkText}
          addFromBulk={addFromBulk}
          updateManualTitle={updateManualTitle}
          updateManualArtist={updateManualArtist}
          removeSong={removeSong}
          toggleSelected={toggleSelected}
          selectAll={selectAll}
          startGame={startGame}
          difficultyId={difficultyId}
          setDifficultyId={setDifficultyId}
          canGoBack={playlist.length > 0}
          onBack={() => setScreen("play")}
        />
      )}

      {screen === "play" && currentSong && (
        <PlayScreen
          key={currentSong.trackId}
          song={currentSong}
          playlist={playlist}
          attempt={attempt}
          guess={guess}
          setGuess={setGuess}
          submitGuess={submitGuess}
          skipAttempt={skipAttempt}
          status={status}
          log={log}
          nextSong={nextSong}
          isLast={songIndex + 1 >= order.length}
          roundNumber={songIndex + 1}
          difficulty={difficulty}
          onOpenSetup={() => setScreen("setup")}
        />
      )}

      {screen === "finished" && (
        <FinishedScreen
          score={score}
          results={roundResults}
          ranking={ranking}
          onRestart={() => setScreen("setup")}
        />
      )}
    </div>
  );
}

function SetupScreen({
  songs,
  bulkText,
  setBulkText,
  addFromBulk,
  updateManualTitle,
  updateManualArtist,
  removeSong,
  toggleSelected,
  selectAll,
  startGame,
  difficultyId,
  setDifficultyId,
  canGoBack,
  onBack,
}) {
  const readyCount = songs.filter((s) => s.status === "ready" && s.title.trim()).length;
  const selectedReadyCount = songs.filter(
    (s) => s.status === "ready" && s.title.trim() && s.selected !== false
  ).length;
  return (
    <div style={styles.setupWrap}>
      <div style={styles.setupHeader}>
        {canGoBack && (
          <button style={styles.backBtn} onClick={onBack}>
            <ChevronLeft size={16} /> Wróć do gry
          </button>
        )}
        <h1 style={styles.setupTitle}>Twoja playlista</h1>
      </div>

      <div style={styles.stateBar}>
        <span style={styles.statePill}>Biblioteka: {songs.length}</span>
        <span style={styles.statePill}>Wybrane: {selectedReadyCount}</span>
        <span style={styles.statePill}>Poziom: {DIFFICULTIES.find((d) => d.id === difficultyId)?.label ?? difficultyId}</span>
      </div>

      <p style={styles.tagline}>
        Wklej linki do utworów na Spotify (jeden na linię) — tytuły i okładki pobierają się same. W Spotify:
        prawy klik na utwór → Udostępnij → Kopiuj link do utworu.
      </p>

      <p style={styles.sectionLabel}>1. Dodaj utwory</p>
      <textarea
        style={styles.bulkTextarea}
        placeholder={"https://open.spotify.com/track/...\nhttps://open.spotify.com/track/...\n..."}
        value={bulkText}
        onChange={(e) => setBulkText(e.target.value)}
        rows={4}
      />
      <button style={styles.ghostBtn} onClick={addFromBulk} disabled={!bulkText.trim()}>
        Dodaj piosenki
      </button>

      {songs.length > 0 && (
        <>
          <p style={styles.sectionLabel}>2. Biblioteka</p>
          <p style={styles.libraryHint}>
            Twoja biblioteka ({songs.length}) — zaznaczone piosenki wejdą do następnej gry.
          </p>
          <div style={styles.selectAllRow}>
            <button style={styles.selectAllBtn} onClick={() => selectAll(true)}>
              Zaznacz wszystkie
            </button>
            <button style={styles.selectAllBtn} onClick={() => selectAll(false)}>
              Odznacz wszystkie
            </button>
          </div>
        </>
      )}

      {songs.length > 0 && (
        <div style={styles.songList}>
          {songs.map((song, index) => (
            <div
              key={song.trackId}
              style={{
                ...styles.songRow,
                animation: "screenEnter 360ms ease both",
                animationDelay: `${Math.min(index, 8) * 35}ms`,
              }}
            >
              {song.status === "ready" && (
                <input
                  type="checkbox"
                  checked={song.selected !== false}
                  onChange={() => toggleSelected(song.trackId)}
                  style={styles.songCheckbox}
                  aria-label="Graj w tę piosenkę"
                />
              )}
              {song.thumbnail && <img src={song.thumbnail} alt="" style={styles.songThumb} />}
              {song.status === "pending" && (
                <>
                  <Loader2 size={16} style={styles.spinIcon} />
                  <span style={styles.songRowPending}>Pobieram tytuł…</span>
                </>
              )}
              {song.status === "ready" && (
                <div style={styles.songRowReadyCol}>
                  <span style={styles.songRowTitle}>{song.title}</span>
                  <input
                    style={styles.songRowArtistInput}
                    placeholder="Wykonawca (opcjonalnie, do podpowiedzi)"
                    value={song.artist || ""}
                    onChange={(e) => updateManualArtist(song.trackId, e.target.value)}
                  />
                </div>
              )}
              {song.status === "error" && (
                <input
                  style={styles.songRowManualInput}
                  placeholder="Nie udało się pobrać — wpisz tytuł ręcznie"
                  value={song.title}
                  onChange={(e) => updateManualTitle(song.trackId, e.target.value)}
                />
              )}
              <button style={styles.iconBtn} onClick={() => removeSong(song.trackId)} aria-label="Usuń piosenkę">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      <p style={styles.libraryHint}>Poziom trudności</p>
      <div style={styles.difficultyRow}>
        {DIFFICULTIES.map((d) => (
          <button
            key={d.id}
            title={`${d.label} — ${d.color}`}
            style={{
              ...styles.difficultyPill,
              background: d.id === difficultyId ? d.color + "33" : "transparent",
              color: d.id === difficultyId ? d.color : "#6B7280",
              border: `1px solid ${d.id === difficultyId ? d.color : "#26292E"}`,
            }}
            onClick={() => setDifficultyId(d.id)}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: d.color,
                display: "inline-block",
                marginRight: 8,
                boxShadow: `0 0 0 2px ${d.color}33`,
              }}
            />
            {d.label}
          </button>
        ))}
      </div>

      <button style={styles.primaryBtn} onClick={startGame} disabled={selectedReadyCount === 0}>
        <Play size={16} /> Zacznij grę {selectedReadyCount > 0 ? `(${selectedReadyCount})` : ""}
      </button>
    </div>
  );
}

// Komponent odtwarzający krótki fragment piosenki z Spotify Embed.
// Działa na osobnym div tworzonej poza Reactem, bo Spotify API modyfikuje DOM bezpośrednio.
function SpotifySnippetPlayer({ trackId, seconds, revealed, onController }) {
  const containerRef = useRef(null);
  const innerElRef = useRef(null); // element tworzony ręcznie na potrzeby Spotify (poza kontrolą Reacta)
  const controllerRef = useRef(null);
  const stepTimeoutRef = useRef(null);
  const loopingRef = useRef(false); // czy fragment ma się teraz zapętlać
  const loopCountRef = useRef(0); // ile razy fragment już zagrał w tym odtworzeniu
  const markerMsRef = useRef(0); // wylosowany punkt startowy dla tej piosenki (ms)
  const cueRef = useRef(null); // stan weryfikacji pozycji przed startem odliczania
  const secondsRef = useRef(seconds);
  secondsRef.current = seconds;
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);

  function safeCall(fn) {
    try {
      const result = fn();
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (e) {
      // ignoruj
    }
  }

  function stopAll() {
    loopingRef.current = false;
    cueRef.current = null;
    if (stepTimeoutRef.current) {
      clearTimeout(stepTimeoutRef.current);
      stepTimeoutRef.current = null;
    }
    setPlaying(false);
    if (controllerRef.current) safeCall(() => controllerRef.current.pause());
  }

  // Dopiero gdy mamy POTWIERDZONĄ (zweryfikowaną) pozycję na znaczniku,
  // zaczynamy faktycznie liczyć czas trwania fragmentu
  function afterCueConfirmed(c) {
    loopCountRef.current += 1;
    stepTimeoutRef.current = setTimeout(() => {
      if (!loopingRef.current) return;
      safeCall(() => c.pause());
      if (loopCountRef.current >= MAX_LOOPS) {
        loopingRef.current = false;
        setTimeout(() => setPlaying(false), 150);
        return;
      }
      stepTimeoutRef.current = setTimeout(() => {
        if (!loopingRef.current) return;
        beginCue(c);
      }, 150);
    }, secondsRef.current * 1000);
  }

  // Wznawia i przeskakuje na znacznik; potwierdzenie (i dopiero wtedy start
  // odliczania) następuje w listenerze playback_update poniżej
  function beginCue(c) {
    cueRef.current = { attempts: 0, lastAttemptAt: Date.now() };
    safeCall(() => c.resume());
    safeCall(() => c.seek(markerMsRef.current / 1000));
  }

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    controllerRef.current = null;
    markerMsRef.current = 20000 + Math.floor(Math.random() * 100000); // 20–120 sekunda
    if (!trackId || !containerRef.current) return;

    // Tworzymy osobny element ręcznie (poza kontrolą Reacta) i wstawiamy go
    // do stałego kontenera — dzięki temu skrypt Spotify może dowolnie
    // modyfikować jego wnętrze bez konfliktu z Reactem przy kolejnych piosenkach
    // Zabezpieczenie: usuń wszystko, co mogło zostać z poprzednich piosenek,
    // zanim dodamy nowy element dla bieżącej (żeby stare odtwarzacze się nie nawarstwiały)
    while (containerRef.current.firstChild) {
      containerRef.current.removeChild(containerRef.current.firstChild);
    }
    const inner = document.createElement("div");
    containerRef.current.appendChild(inner);
    innerElRef.current = inner;

    loadSpotifyIframeApi().then((IFrameAPI) => {
      if (cancelled) return;
      IFrameAPI.createController(
        inner,
        { uri: `spotify:track:${trackId}`, width: "100%", height: "152" },
        (EmbedController) => {
          if (cancelled) return;
          controllerRef.current = EmbedController;
          setReady(true);
          if (onController) onController(EmbedController);

          // Weryfikacja pozycji: sprawdzamy, czy odtwarzacz faktycznie
          // wylądował na znaczniku; jeśli nie, ponawiamy seek (max kilka razy)
          EmbedController.addListener("playback_update", (e) => {
            const cue = cueRef.current;
            if (!cue) return;
            const pos = e && e.data ? e.data.position : null;
            const paused = e && e.data ? e.data.isPaused : null;
            if (typeof pos !== "number" || paused) return;
            const target = markerMsRef.current;
            if (Math.abs(pos - target) < 1200) {
              cueRef.current = null;
              afterCueConfirmed(EmbedController);
              return;
            }
            const now = Date.now();
            if (cue.attempts < 6 && now - cue.lastAttemptAt > 350) {
              cue.attempts += 1;
              cue.lastAttemptAt = now;
              safeCall(() => EmbedController.seek(target / 1000));
            } else if (cue.attempts >= 6) {
              cueRef.current = null;
              afterCueConfirmed(EmbedController);
            }
          });
        }
      );
    });
    return () => {
      cancelled = true;
      loopingRef.current = false;
      cueRef.current = null;
      if (stepTimeoutRef.current) clearTimeout(stepTimeoutRef.current);
      // Bezpiecznie usuń nasz ręcznie utworzony element, jeśli nadal jest na miejscu
      try {
        if (innerElRef.current && innerElRef.current.parentNode === containerRef.current) {
          containerRef.current.removeChild(innerElRef.current);
        }
      } catch (e) {
        // ignoruj — element mógł już zniknąć razem z całym drzewem (np. koniec gry)
      }
      innerElRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId]);

  // Nowa próba (inna długość fragmentu) albo odsłonięcie odpowiedzi — zatrzymaj pętlę
  useEffect(() => {
    stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, revealed]);

  // Uruchamia odtwarzanie fragmentu piosenki z losowo wybranym punktem startowym.
  // Dzięki temu za każdym razem można odsłuchać inny fragment tej samej piosenki.
  function playClip() {
    const c = controllerRef.current;
    if (!c || playing) return;
    setPlaying(true);
    loopingRef.current = true;
    loopCountRef.current = 0;
    beginCue(c);
  }

  if (!trackId) return null;

  return (
    <>
      <div style={revealed ? styles.spotifyEmbedOuter : styles.spotifyEmbedOuterHidden}>
        <div ref={containerRef} style={styles.spotifyEmbedInner} />
      </div>
      <button style={styles.playCircleBtn} disabled={!ready || playing || revealed} onClick={playClip}>
        <Play size={26} color="#0D0F10" fill="#0D0F10" style={{ marginLeft: 3 }} />
      </button>
    </>
  );
}

// Ekran głównej rozgrywki. Tutaj jest aktualna piosenka, licznik prób,
// wejście użytkownika, podpowiedzi i lista błędnych odpowiedzi.
function PlayScreen({
  song,
  playlist,
  attempt,
  guess,
  setGuess,
  submitGuess,
  skipAttempt,
  status,
  log,
  nextSong,
  isLast,
  roundNumber,
  difficulty,
  onOpenSetup,
}) {
  const roundOver = status === "correct" || status === "revealed";
  const seconds = unlockedSeconds(difficulty, attempt);
  const blurPx = roundOver ? 0 : Math.max(22 - attempt * 4, 2);

  // Tworzymy tablicę z maksymalną liczbą prób, żeby w UI zawsze było miejsce na wpisy
  // odrzuconych odpowiedzi oraz pominięte rundy.
  const rows = Array.from({ length: MAX_ATTEMPTS }).map((_, i) => log[i] || null);

  // Ustawienie frazy do wyszukiwania podpowiedzi: jeśli użytkownik wpisze "kama",
  // pojawią się utwory zawierające taką frazę w tytule lub wykonawcy.
  const query = normalizeForSearch(guess.trim());
  const suggestions =
    !roundOver && query.length > 0
      ? (playlist || [])
          .filter(
            (s) =>
              normalizeForSearch(s.title).includes(query) || normalizeForSearch(s.artist).includes(query)
          )
          .slice(0, 6)
      : [];

  return (
    <div style={styles.playWrap}>
      <div style={styles.topBar}>
        <button style={styles.settingsBtn} onClick={onOpenSetup} aria-label="Zarządzaj playlistą">
          <Settings size={16} />
        </button>
        <span style={{ ...styles.difficultyBadge, color: difficulty.color, borderColor: difficulty.color }}>
          {difficulty.label}
        </span>
        <span style={styles.statusPill}>{roundOver ? "Wynik rundy" : "Aktualna runda"}</span>
      </div>

      <div style={styles.titleRow}>
        <div>
          <h1 style={styles.gameTitle}>Zgadnij Piosenkę</h1>
          <p style={{ ...styles.attemptSubtitle, color: difficulty.color }}>{attempt} z {MAX_ATTEMPTS} prób</p>
        </div>
        <span style={styles.roundBadge}>#{roundNumber}</span>
      </div>

      <div style={styles.coverWrap}>
        {song.thumbnail ? (
          <img
            src={song.thumbnail}
            alt=""
            style={{ ...styles.coverImg, filter: `blur(${blurPx}px)`, transform: `scale(${roundOver ? 1 : 1.15})` }}
          />
        ) : (
          <div style={styles.coverFallback}>
            <Music2 size={40} color="#2A2E33" />
          </div>
        )}
      </div>

      <div style={styles.segmentBar}>
        {difficulty.seconds.map((secs, i) => (
          <div
            key={i}
            style={{
              ...styles.segment,
              flex: secs,
              background: i < attempt || roundOver ? difficulty.color : "#1D2024",
            }}
          />
        ))}
      </div>

      <div style={styles.transportRow}>
        <SpotifySnippetPlayer trackId={song.trackId} seconds={seconds} revealed={roundOver} />
        <span style={{ ...styles.secondsLabel, color: difficulty.color }}>{roundOver ? "" : `${seconds}s`}</span>
      </div>

      {!roundOver && (
        <div style={styles.guessWrap}>
          <div style={styles.guessRow}>
            <input
              style={styles.guessInput}
              placeholder="Wpisz tytuł piosenki…"
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitGuess()}
              autoFocus
            />
            <button style={{ ...styles.guessBtn, background: difficulty.color }} onClick={submitGuess}>
              Zgadnij
            </button>
          </div>
          {suggestions.length > 0 && (
            <div style={styles.suggestionsBox}>
              {suggestions.map((s) => (
                <button
                  key={s.trackId}
                  style={styles.suggestionItem}
                  onClick={() => setGuess(s.title)}
                  type="button"
                >
                  {s.thumbnail && <img src={s.thumbnail} alt="" style={styles.suggestionThumb} />}
                  <span style={styles.suggestionTitle}>{s.title}</span>
                  {s.artist && <span style={styles.suggestionArtist}>{s.artist}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={styles.attemptsList}>
        {/* Każda próba zostaje odnotowana w liście, aby użytkownik widział,
            co już wpisywał i ile prób mu zostało. */}
        {rows.map((entry, i) => {
          if (!entry) {
            return (
              <div key={i} style={styles.attemptRow}>
                <SkipForward size={15} color="#4B4F56" />
                <span style={styles.attemptSkippedText}>Pominięte</span>
              </div>
            );
          }
          if (entry.type === "skip") {
            return (
              <div key={i} style={styles.attemptRow}>
                <SkipForward size={15} color="#6B7280" />
                <span style={styles.attemptSkippedText}>Pominięte</span>
              </div>
            );
          }
          return (
            <div key={i} style={styles.attemptRow}>
              <X size={15} color="#D9483C" />
              <span style={styles.attemptWrongText}>{entry.text}</span>
            </div>
          );
        })}
      </div>

      {!roundOver && (
        <button style={styles.skipBtn} onClick={skipAttempt}>
          <SkipForward size={15} /> Pomiń próbę
        </button>
      )}

      {roundOver && (
        <div style={styles.resultBlock}>
          <div
            style={{
              ...styles.feedback,
              color: status === "correct" ? "#2ED573" : "#D9483C",
            }}
          >
            {status === "correct" ? <Check size={16} /> : <X size={16} />}
            {status === "correct" ? "Dokładnie tak!" : "Próby się skończyły"}
          </div>
          <p style={styles.resultTitle}>{song.title}</p>
          <button style={{ ...styles.primaryBtn, background: difficulty.color }} onClick={nextSong}>
            {isLast ? "Pokaż wynik" : "Następna piosenka"}
          </button>
        </div>
      )}
    </div>
  );
}

// Ekran końcowy pokazuje sumę punktów, tabelę rund oraz ranking najlepszych wyników.
// Każda poprawna odpowiedź daje punkty zależnie od numeru próby.
function FinishedScreen({ score, results, ranking, onRestart }) {
  const maxScore = results.length * MAX_ATTEMPTS;
  const topSongs = [...(ranking || [])].sort((a, b) => b.points - a.points).slice(0, 5);

  return (
    <div style={styles.finishedWrap}>
      <p style={styles.finishedLabel}>Wynik końcowy</p>
      <p style={styles.finishedScore}>
        {score} <span style={styles.finishedMax}>/ {maxScore}</span>
      </p>

      <div style={styles.resultsList}>
        {results.map((r, i) => (
          <div key={i} style={styles.resultLine}>
            <span>{r.title}</span>
            <span style={{ color: r.points > 0 ? "#2ED573" : "#D9483C" }}>
              {r.points > 0 ? `+${r.points} pkt` : "0 pkt"}
            </span>
          </div>
        ))}
      </div>

      <div style={styles.rankingBox}>
        <p style={styles.finishedLabel}>Ranking piosenek</p>
        {topSongs.length > 0 ? (
          <div style={styles.rankingList}>
            {topSongs.map((entry, index) => (
              <div key={`${entry.title}-${entry.date}-${index}`} style={styles.rankingRow}>
                <span style={styles.rankingIndex}>#{index + 1}</span>
                <span style={styles.rankingTitle}>{entry.title}</span>
                <span style={styles.rankingScore}>{entry.points} pkt</span>
                <span style={styles.rankingMeta}>{entry.date}</span>
              </div>
            ))}
          </div>
        ) : (
          <p style={styles.emptyRanking}>Brak zapisanych piosenek w rankingu.</p>
        )}
      </div>

      <button style={styles.primaryBtn} onClick={onRestart}>
        <RotateCcw size={16} /> Zagraj ponownie
      </button>
    </div>
  );
}

const fontImport = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes screenEnter {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes feedbackPop {
  0% { opacity: 0; transform: scale(0.94); }
  70% { opacity: 1; transform: scale(1.025); }
  100% { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
input::placeholder, textarea::placeholder { color: #6B7280; }
`;

const styles = {
  page: {
    minHeight: "100vh",
    background: "#0D0F10",
    color: "#F5F6F7",
    fontFamily: "'Poppins', sans-serif",
    padding: "24px 20px 60px",
  },
  setupWrap: { maxWidth: 560, margin: "0 auto", animation: "screenEnter 420ms ease both" },
  setupHeader: { marginBottom: 18 },
  stateBar: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  statePill: {
    display: "inline-flex",
    alignItems: "center",
    padding: "6px 10px",
    borderRadius: 999,
    background: "#17191C",
    border: "1px solid #24272B",
    color: "#D1D5DB",
    fontSize: 12,
    fontWeight: 600,
  },
  backBtn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    background: "transparent",
    border: "none",
    color: "#6B7280",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
    padding: 0,
    marginBottom: 10,
  },
  setupTitle: { fontSize: 22, fontWeight: 700, margin: 0, color: "#FFFFFF" },
  tagline: { color: "#8B8F96", lineHeight: 1.6, fontSize: 14.5, marginBottom: 16 },
  sectionLabel: {
    margin: "0 0 10px",
    color: "#E5E7EB",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  bulkTextarea: {
    width: "100%",
    background: "#17191C",
    border: "1px solid #24272B",
    borderRadius: 12,
    padding: "12px 14px",
    color: "#F5F6F7",
    fontSize: 13.5,
    fontFamily: "inherit",
    outline: "none",
    resize: "vertical",
    marginBottom: 10,
    boxSizing: "border-box",
  },
  ghostBtn: {
    background: "transparent",
    border: "1px solid #24272B",
    color: "#F5F6F7",
    padding: "9px 14px",
    borderRadius: 10,
    fontSize: 13.5,
    cursor: "pointer",
    fontFamily: "inherit",
    marginBottom: 20,
  },
  libraryHint: { color: "#8B8F96", fontSize: 13, marginBottom: 8 },
  selectAllRow: { display: "flex", gap: 8, marginBottom: 10 },
  selectAllBtn: {
    background: "transparent",
    border: "1px solid #24272B",
    color: "#8B8F96",
    padding: "6px 12px",
    borderRadius: 8,
    fontSize: 12.5,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  songCheckbox: { width: 16, height: 16, flexShrink: 0, cursor: "pointer", accentColor: "#2ED573" },
  songList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginBottom: 20,
    maxHeight: 420,
    overflowY: "auto",
    paddingRight: 4,
  },
  songRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#17191C",
    border: "1px solid #24272B",
    borderRadius: 10,
    padding: "8px 12px",
  },
  songThumb: { width: 34, height: 34, borderRadius: 6, objectFit: "cover", flexShrink: 0 },
  spinIcon: { animation: "spin 1s linear infinite", color: "#2ED573", flexShrink: 0 },
  songRowPending: { color: "#8B8F96", fontSize: 13.5, flex: 1 },
  songRowTitle: { flex: 1, fontSize: 14 },
  songRowReadyCol: { flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  songRowArtistInput: {
    background: "transparent",
    border: "1px dashed #24272B",
    borderRadius: 6,
    padding: "4px 8px",
    color: "#8B8F96",
    fontSize: 12,
    fontFamily: "inherit",
    outline: "none",
  },
  songRowManualInput: {
    flex: 1,
    background: "#0D0F10",
    border: "1px solid #D9483C",
    borderRadius: 8,
    padding: "6px 10px",
    color: "#F5F6F7",
    fontSize: 13.5,
    fontFamily: "inherit",
    outline: "none",
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: "#6B7280",
    cursor: "pointer",
    padding: 4,
    display: "flex",
    flexShrink: 0,
  },
  primaryBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    background: "#2ED573",
    border: "none",
    color: "#0D0F10",
    padding: "14px 14px",
    borderRadius: 999,
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "'Poppins', sans-serif",
  },

  playWrap: { maxWidth: 520, margin: "0 auto", position: "relative", animation: "screenEnter 420ms ease both" },
  topBar: { display: "flex", alignItems: "center", gap: 10, marginBottom: 22, flexWrap: "wrap" },
  settingsBtn: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: "#17191C",
    border: "1px solid #24272B",
    color: "#8B8F96",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  statusPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderRadius: 999,
    background: "#17191C",
    border: "1px solid #24272B",
    color: "#D1D5DB",
    fontSize: 11.5,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  difficultyRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  difficultyBadge: {
    padding: "6px 14px",
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: 600,
    borderWidth: 1,
    borderStyle: "solid",
    background: "transparent",
  },
  difficultyPill: {
    padding: "8px 16px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "'Poppins', sans-serif",
  },
  titleRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 },
  gameTitle: { fontSize: 24, fontWeight: 700, margin: "0 0 4px" },
  attemptSubtitle: { fontSize: 13.5, fontWeight: 600, margin: 0 },
  roundBadge: { color: "#4B4F56", fontSize: 13.5, fontWeight: 600 },
  coverWrap: {
    width: 220,
    height: 220,
    margin: "0 auto 22px",
    borderRadius: 20,
    overflow: "hidden",
    background: "#17191C",
    animation: "screenEnter 500ms ease both",
  },
  coverImg: { width: "100%", height: "100%", objectFit: "cover", transition: "filter 0.4s ease" },
  coverFallback: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" },
  segmentBar: { display: "flex", gap: 5, marginBottom: 22 },
  segment: { flex: 1, height: 6, borderRadius: 4, transition: "background 0.3s ease" },
  transportRow: { display: "flex", alignItems: "center", gap: 12, marginBottom: 24, position: "relative" },
  playCircleBtn: {
    width: 58,
    height: 58,
    borderRadius: "50%",
    background: "#2ED573",
    border: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
    margin: "0 auto",
  },
  secondsLabel: { fontSize: 13.5, fontWeight: 700, minWidth: 30, textAlign: "right" },
  guessRow: { display: "flex", gap: 10, width: "100%" },
  guessWrap: { position: "relative", marginBottom: 16 },
  suggestionsBox: {
    position: "absolute",
    top: "calc(100% - 12px)",
    left: 0,
    right: 0,
    background: "#17191C",
    border: "1px solid #24272B",
    borderRadius: 12,
    overflow: "hidden",
    zIndex: 5,
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
  },
  suggestionItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid #202327",
    padding: "9px 12px",
    color: "#F5F6F7",
    fontSize: 13.5,
    fontFamily: "inherit",
    cursor: "pointer",
    textAlign: "left",
  },
  suggestionThumb: { width: 24, height: 24, borderRadius: 4, objectFit: "cover", flexShrink: 0 },
  suggestionTitle: { flex: 1 },
  suggestionArtist: { color: "#6B7280", fontSize: 12 },
  guessInput: {
    flex: 1,
    background: "#17191C",
    border: "1px solid #24272B",
    borderRadius: 12,
    padding: "13px 16px",
    color: "#F5F6F7",
    fontSize: 15,
    fontFamily: "inherit",
    outline: "none",
  },
  guessBtn: {
    border: "none",
    color: "#0D0F10",
    padding: "0 22px",
    borderRadius: 12,
    fontSize: 14.5,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "'Poppins', sans-serif",
  },
  attemptsList: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 },
  attemptRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "#141618",
    border: "1px solid #202327",
    borderRadius: 10,
    padding: "12px 16px",
  },
  attemptSkippedText: { color: "#5A5E66", fontSize: 14 },
  attemptWrongText: { color: "#F5F6F7", fontSize: 14, fontWeight: 600 },
  skipBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    width: "100%",
    background: "transparent",
    border: "1px dashed #24272B",
    color: "#6B7280",
    padding: "10px 14px",
    borderRadius: 10,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
    marginBottom: 8,
  },
  resultBlock: { textAlign: "center", marginTop: 10 },
  feedback: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    fontSize: 14,
    fontWeight: 600,
    marginBottom: 6,
    animation: "feedbackPop 360ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
  },
  resultTitle: { fontSize: 19, fontWeight: 700, margin: "0 0 18px" },

  spotifyEmbedOuter: {
    position: "relative",
    width: "100%",
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 8,
  },
  spotifyEmbedOuterHidden: {
    position: "relative",
    width: "100%",
    height: 0,
    overflow: "hidden",
    visibility: "hidden",
  },
  spotifyEmbedInner: { width: "100%" },

  finishedWrap: { maxWidth: 420, margin: "0 auto", textAlign: "center", animation: "screenEnter 420ms ease both" },
  finishedLabel: { color: "#8B8F96", fontSize: 13.5, marginBottom: 4, letterSpacing: "0.02em" },
  finishedScore: { fontSize: 52, fontWeight: 700, margin: "0 0 24px", color: "#2ED573" },
  finishedMax: { fontSize: 22, color: "#4B4F56", fontWeight: 400 },
  resultsList: {
    display: "flex",
    flexDirection: "column",
    gap: 9,
    marginBottom: 24,
    textAlign: "left",
    background: "#17191C",
    border: "1px solid #24272B",
    borderRadius: 14,
    padding: 16,
  },
  resultLine: { display: "flex", justifyContent: "space-between", fontSize: 14 },
  rankingBox: {
    background: "#17191C",
    border: "1px solid #24272B",
    borderRadius: 14,
    padding: 16,
    marginBottom: 20,
    textAlign: "left",
  },
  rankingList: { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 },
  rankingRow: {
    display: "grid",
    gridTemplateColumns: "40px 1fr auto auto",
    gap: 8,
    alignItems: "center",
    fontSize: 12,
    color: "#E5E7EB",
    background: "#121519",
    borderRadius: 10,
    padding: "8px 10px",
  },
  rankingIndex: { color: "#8B8F96", fontWeight: 700 },
  rankingTitle: { fontWeight: 600, color: "#F5F6F7", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rankingScore: { fontWeight: 700, color: "#2ED573" },
  rankingMeta: { color: "#8B8F96", fontSize: 11 },
  emptyRanking: { color: "#8B8F96", fontSize: 13, margin: 0 },
}