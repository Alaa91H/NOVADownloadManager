/* src/components/Logo.tsx */
import React from 'react';
import logoImg from '../assets/logo.png';
import { useAppStore } from '../state/appStore';

interface LogoProps {
  className?: string;
  size?: number;
}

export const Logo: React.FC<LogoProps> = ({ className = '', size = 24 }) => {
  const { t } = useAppStore();
  return (
    <img
      src={logoImg}
      alt={t('logo_alt')}
      width={size}
      height={size}
      className={`${className} select-none object-contain`}
      style={{ display: 'inline-block', verticalAlign: 'middle', width: size, height: size }}
      referrerPolicy="no-referrer"
    />
  );
};
