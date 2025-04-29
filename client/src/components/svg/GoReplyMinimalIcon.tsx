import { cn } from '~/utils';

export default function GoReplyMinimalIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      width="800px"  // Matching width
      height="800px" // Matching height
      viewBox="0 0 283 283" // Keep the original viewBox
      className={cn('h-4 w-4', className)}
    >
      <g transform="translate(0,283) scale(0.1,-0.1)">
        <path d="M1969 2216 c-51 -35 -72 -85 -67 -155 7 -97 65 -151 163 -151 103 0 165 62 165 165 0 70 -22 114 -72 145 -49 30 -142 28 -189 -4z" />
        <path d="M1187 2023 c-12 -12 -7 -22 26 -53 40 -37 37 -37 235 -74 90 -17 164 -34 165 -38 1 -4 -93 -110 -210 -235 l-211 -228 -274 -39 c-150 -21 -285 -40 -300 -43 -40 -8 -36 -41 10 -91 l39 -42 84 0 c46 0 189 3 317 7 l234 6 76 46 77 46 139 -110 c76 -60 144 -119 151 -130 7 -11 25 -109 39 -217 14 -108 29 -204 32 -212 10 -25 90 -22 104 4 7 14 10 102 8 263 l-3 242 -132 177 -132 177 129 170 c86 113 130 179 130 196 0 13 -23 60 -51 105 l-51 80 -312 0 c-172 0 -316 -3 -319 -7z" />
      </g>
    </svg>
  );
}