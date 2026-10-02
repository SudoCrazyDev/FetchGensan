import type { Metadata } from 'next';
import { Geist, Geist_Mono, Plus_Jakarta_Sans } from 'next/font/google';

import { Providers } from '@/components/Providers';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
// The wordmark face. Only the logo uses it; the console UI stays in Geist.
const brandFont = Plus_Jakarta_Sans({
  variable: '--font-brand',
  subsets: ['latin'],
  weight: '800',
});

export const metadata: Metadata = {
  title: 'FetchGensan Dispatch',
  description: 'Live dispatch board and driver roster for FetchGensan.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${brandFont.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
