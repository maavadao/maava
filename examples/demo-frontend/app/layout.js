import "./globals.css";

export const metadata = { title: "mawaDao Agent Platform — Demo" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
