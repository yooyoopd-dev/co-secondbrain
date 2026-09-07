import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './tokens.css';

// 렌더러에서 난 것도 main 의 버퍼로 모은다. 기록이 두 군데로 갈리면 복사본이 반쪽이 된다.
// React 19 는 렌더 중 예외를 `reportError` 로 다시 던지므로 이 두 개면 다 잡힌다.
window.addEventListener('error', (e) => {
  void window.sb?.reportError('window', e.message, e.error instanceof Error ? e.error.stack : undefined);
});
window.addEventListener('unhandledrejection', (e) => {
  const r: unknown = e.reason;
  void window.sb?.reportError(
    'promise',
    r instanceof Error ? `${r.name}: ${r.message}` : String(r),
    r instanceof Error ? r.stack : undefined,
  );
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
