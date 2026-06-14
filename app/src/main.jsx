import React from "react";
import ReactDOM from "react-dom/client";
// 폰트 로컬 번들 (오프라인 구동 — Google Fonts CDN 불필요)
import "@fontsource/orbitron/700.css";
import "@fontsource/orbitron/800.css";
import "@fontsource/chakra-petch/400.css";
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./index.css";
import App from "./App.jsx";
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
