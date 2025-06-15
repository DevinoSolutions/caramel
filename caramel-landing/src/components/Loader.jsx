import Image from 'next/image'
import React from 'react'

const Loader = () => {
    const logoStyle= {
        width: '120px',
        height: '120px',
        animation: 'pulse 1.5s ease-in-out infinite',
    }
    return (
        <div>
            <Image
                src={'/logo.png'}
                alt="logo"
                height={2000}
                width={20000}
                priority
                style={logoStyle}
            />
            <style>{`
                @keyframes pulse {
                    0%,
                    100% {
                        transform: scale(1);
                    }
                    50% {
                        transform: scale(1.1);
                    }
                }
            `}</style>
        </div>
    )
}

export default Loader
