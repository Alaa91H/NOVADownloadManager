/* src/components/Logo.tsx */
import React from 'react';
import logoImg from '../assets/logo.png';

interface LogoProps {
  className?: string;
  size?: number;
}

export const Logo: React.FC<LogoProps> = ({ className = '', size = 24 }) => {
  return (
    <img 
      src={logoImg} 
      alt="NOVA Logo" 
      width={size} 
      height={size} 
      className={`${className} select-none object-contain`}
      style={{ display: 'inline-block', verticalAlign: 'middle', width: size, height: size }}
      referrerPolicy="no-referrer"
    />
  );
};
