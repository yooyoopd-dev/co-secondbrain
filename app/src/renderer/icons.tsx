// 아이콘. design/design.md 의 Don'ts — "No emojis in UI — use icon system only".
//
// 라이브러리를 붙이지 않고 직접 그린다. 사내망에서 CDN 을 못 쓰고, 여기 필요한 것이
// 열 개뿐이라 패키지 하나를 더 얹을 이유가 없다. 24 격자·선 굵기 1.75·둥근 끝으로
// 통일한다 — 굵기와 끝 처리가 어긋나면 한 벌로 안 보인다.
import type { SVGProps } from 'react';

const PATHS = {
  lock: ['M5 11h14v10H5z', 'M8.5 11V7a3.5 3.5 0 0 1 7 0v4'],
  users: ['M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16.5 5.4a3.5 3.5 0 0 1 0 5.2', 'M18 14.4A6.5 6.5 0 0 1 21.5 20'],
  plus: ['M12 5v14', 'M5 12h14'],
  alert: ['M12 3.5 2.5 20.5h19z', 'M12 10v4.5', 'M12 17.6h.01'],
  copy: ['M9 9h11v11H9z', 'M5 15a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2'],
  save: ['M12 3v11', 'M7.5 10.5 12 15l4.5-4.5', 'M4 19.5h16'],
  trash: ['M4 6.5h16', 'M9.5 6.5V3.5h5v3', 'M6.5 6.5 7.5 20.5h9l1-14'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  gear: [
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4',
    'M12 17.8a5.8 5.8 0 1 0 0-11.6 5.8 5.8 0 0 0 0 11.6',
    'M12 2.6v3.6', 'M12 17.8v3.6', 'M2.6 12h3.6', 'M17.8 12h3.6',
  ],
  user: ['M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7', 'M5 20a7 7 0 0 1 14 0'],
} as const;

export type IconName = keyof typeof PATHS;

/** 글자 옆에 놓는다. `currentColor` 를 따라가므로 색은 부모가 정한다. */
export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none', ...rest.style }}
      {...rest}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
