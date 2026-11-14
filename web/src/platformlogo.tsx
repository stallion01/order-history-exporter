// A small mark for each booking site, drawn in the current text colour so it sits on
// any coloured bar: Airbnb, Vrbo, Booking.com, and direct bookings made in Hospitable.
import { cx } from './ui';

export function PlatformLogo({ platform, className }: { platform: string; className?: string }) {
  const props = { viewBox: '0 0 24 24', className: cx('size-4 shrink-0', className), 'aria-hidden': true as const };
  if (platform === 'airbnb')
    return (
      <svg {...props} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round">
        <path d="M12 3c-1.5 0-2.4 1.2-3.2 2.8l-4.2 8.8C3.4 17.2 5 20 7.6 20c1.7 0 3-1.2 4.4-2.8 1.4 1.6 2.7 2.8 4.4 2.8 2.6 0 4.2-2.8 3-5.4l-4.2-8.8C14.4 4.2 13.5 3 12 3Z" />
        <path d="M12 17.2c-1.6-2-2.6-3.8-2.6-5.2 0-1.5 1.2-2.4 2.6-2.4s2.6.9 2.6 2.4c0 1.4-1 3.2-2.6 5.2Z" />
      </svg>
    );
  if (platform === 'vrbo' || platform === 'homeaway')
    return (
      <svg {...props} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 5l6.5 14L17 5" />
        <path d="M14.5 5h5.5M8 5l4.5 9.5" />
      </svg>
    );
  if (platform === 'booking')
    return (
      <svg {...props}>
        <text x="2" y="18.5" fill="currentColor" fontSize="18" fontWeight="800" fontFamily="Arial, Helvetica, sans-serif">
          B
        </text>
        <circle cx="19.5" cy="17" r="2.2" fill="currentColor" />
      </svg>
    );
  // Direct bookings, taken in Hospitable.
  return (
    <svg {...props} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
      <circle cx="12" cy="10" r="5.5" />
      <path d="M8 20.5h8" />
    </svg>
  );
}
