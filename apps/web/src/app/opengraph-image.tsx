import { ImageResponse } from 'next/og';

export const alt = 'Vidak — your eVault video library';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        alignItems: 'center',
        background: '#0B1325',
        color: 'white',
        display: 'flex',
        height: '100%',
        padding: '76px',
        width: '100%',
      }}
    >
      <div
        style={{
          alignItems: 'center',
          background: '#102A4C',
          borderRadius: '42px',
          display: 'flex',
          fontSize: '180px',
          fontWeight: 700,
          height: '260px',
          justifyContent: 'center',
          lineHeight: 1,
          position: 'relative',
          width: '260px',
        }}
      >
        V
        <div
          style={{
            background: '#22C6C8',
            borderRadius: '999px',
            height: '42px',
            position: 'absolute',
            right: '32px',
            top: '32px',
            width: '42px',
          }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginLeft: '44px' }}>
        <div style={{ fontSize: '94px', fontWeight: 700, letterSpacing: '-4px' }}>Vidak</div>
        <div style={{ color: '#AAB8D4', fontSize: '34px', marginTop: '18px' }}>
          Decentralized video hosting
        </div>
      </div>
    </div>,
    size,
  );
}
